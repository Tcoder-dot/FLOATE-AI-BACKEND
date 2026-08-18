import express from 'express';
import { config } from '../config.js';
import { sheetsDb, BusinessListing, normalizePhone, escapeMarkdownText, isSpotlightBusiness } from './sheetsService.js';
import { firestoreDb } from './firestoreService.js';
import {
  parseShoppingQuery,
  transcribeAndAnalyzeAudio,
  validateSelfieWithGeminiVision,
} from './aiService.js';
import {
  getWhatsAppSession,
  updateWhatsAppSession,
  resetWhatsAppSession,
} from './whatsappStateManager.js';
import { submitVendorReport, alertAdminNewVendorRegistration } from './whatsappAdminService.js';

export interface WhatsAppButton {
  id: string;
  title: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
}

export interface SendWhatsAppOptions {
  preview_url?: boolean;
  ctaUrl?: {
    displayText: string;
    url: string;
    headerText?: string;
    footerText?: string;
  };
  quickReplies?: WhatsAppButton[];
  listMenu?: {
    buttonText: string;
    title?: string;
    sections: WhatsAppListSection[];
  };
}

function pushWaLog(msg: string) {
  if (!(globalThis as any).__RECENT_WA_LOGS) {
    (globalThis as any).__RECENT_WA_LOGS = [];
  }
  const timestamp = new Date().toISOString().substring(11, 19);
  (globalThis as any).__RECENT_WA_LOGS.unshift(`[${timestamp}] ${msg}`);
  if ((globalThis as any).__RECENT_WA_LOGS.length > 30) {
    (globalThis as any).__RECENT_WA_LOGS.pop();
  }
}

/**
 * Sends a message back to a WhatsApp user via Meta's WhatsApp Cloud API
 * Supports standard text, 1-3 interactive buttons, and native slide-up List Menus
 */
export async function sendWhatsAppMessage(
  toPhone: string,
  messageText: string,
  options?: SendWhatsAppOptions
): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || config.whatsappAccessToken;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || config.whatsappPhoneNumberId;

  const cleanTo = toPhone.replace(/\D/g, '');

  pushWaLog(`📤 Outgoing request to +${cleanTo}: ${messageText.slice(0, 60)}...`);

  if (!token || !phoneNumberId) {
    pushWaLog(`❌ FAILED: Token or Phone Number ID is missing!`);
    console.warn(`[WhatsApp Send Error] ❌ Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.`);
    return false;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  let payload: any;

  // 1. Native CTA URL Button (Opens wa.me or custom link directly on tap)
  if (options?.ctaUrl) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: options.ctaUrl.headerText
          ? {
              type: 'text',
              text: options.ctaUrl.headerText.substring(0, 60),
            }
          : undefined,
        body: {
          text: messageText,
        },
        footer: options.ctaUrl.footerText
          ? {
              text: options.ctaUrl.footerText.substring(0, 60),
            }
          : undefined,
        action: {
          name: 'cta_url',
          parameters: {
            display_text: options.ctaUrl.displayText.substring(0, 20),
            url: options.ctaUrl.url,
          },
        },
      },
    };
  }
  // 2. Native Slide-Up List Menu
  else if (options?.listMenu && options.listMenu.sections.length > 0) {
    let totalRowsCount = 0;
    const clampedSections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> = [];

    for (const sec of options.listMenu.sections) {
      if (totalRowsCount >= 10) break;
      const remainingSlots = 10 - totalRowsCount;
      const validRows = sec.rows.slice(0, remainingSlots).map((r) => ({
        id: r.id.substring(0, 200),
        title: (r.title || 'Option').substring(0, 24),
        description: r.description ? r.description.substring(0, 72) : undefined,
      }));

      if (validRows.length > 0) {
        clampedSections.push({
          title: (sec.title || 'Options').substring(0, 24),
          rows: validRows,
        });
        totalRowsCount += validRows.length;
      }
    }

    const safeBody = messageText.length > 1020 ? messageText.substring(0, 1017) + '...' : messageText;

    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: (options.listMenu.title || 'FLOATE Verified Vendors').substring(0, 60),
        },
        body: {
          text: safeBody,
        },
        action: {
          button: (options.listMenu.buttonText || 'Select Vendor').substring(0, 20),
          sections: clampedSections,
        },
      },
    };
  }
  // 3. Interactive Quick Reply Buttons (Max 3)
  else if (options?.quickReplies && options.quickReplies.length > 0 && options.quickReplies.length <= 3) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: messageText,
        },
        action: {
          buttons: options.quickReplies.map((b) => ({
            type: 'reply',
            reply: {
              id: b.id.substring(0, 256),
              title: b.title.substring(0, 20),
            },
          })),
        },
      },
    };
  }
  // 3. Standard Text Message
  else {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: options?.preview_url ?? true,
        body: messageText,
      },
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const resData: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      pushWaLog(`❌ Meta HTTP ${res.status} Error: ${JSON.stringify(resData?.error || resData)}`);
      console.error(`[WhatsApp API Error] Meta rejected message to +${cleanTo}:`, JSON.stringify(resData, null, 2));

      // If interactive button or list failed, fallback to plain text
      if (payload.type === 'interactive') {
        console.log(`[WhatsApp Fallback] Retrying as plain text...`);
        return sendWhatsAppMessage(toPhone, messageText, { preview_url: true });
      }
      return false;
    }

    const messageId = resData?.messages?.[0]?.id || 'OK';
    pushWaLog(`✅ Accepted by Meta: ID ${messageId}`);
    return true;
  } catch (err: any) {
    pushWaLog(`❌ Network error: ${err?.message || err}`);
    console.error(`[WhatsApp Send Fatal Error] Failed sending to +${cleanTo}:`, err?.message || err);
    return false;
  }
}

/**
 * Sends the official native WhatsApp vCard / Contact Card to a user
 */
export async function sendWhatsAppContactCard(
  toPhone: string,
  contact?: {
    name?: string;
    phone?: string;
    org?: string;
  }
): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || config.whatsappAccessToken;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || config.whatsappPhoneNumberId;
  const cleanTo = toPhone.replace(/\D/g, '');

  if (!token || !phoneNumberId) return false;

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  const botPhone = process.env.WHATSAPP_PHONE_NUMBER || contact?.phone || '2348000000000';
  const cleanBotPhone = botPhone.replace(/\D/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanTo,
    type: 'contacts',
    contacts: [
      {
        name: {
          formatted_name: contact?.name || 'Floate AI - Market Finder',
          first_name: 'Floate AI',
          last_name: 'Market Finder',
        },
        org: {
          company: contact?.org || 'Floate Nigeria',
          department: 'Verified Merchant Network',
          title: 'Smart Marketplace Assistant',
        },
        phones: [
          {
            phone: `+${cleanBotPhone}`,
            type: 'WORK',
            wa_id: cleanBotPhone,
          },
        ],
        urls: [
          {
            url: 'https://floate.xyz',
            type: 'WORK',
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const resData: any = await res.json().catch(() => ({}));
    if (res.ok) {
      pushWaLog(`✅ Sent Floate Contact Card to +${cleanTo}`);
      return true;
    } else {
      pushWaLog(`⚠️ Contact card send response: ${JSON.stringify(resData?.error || resData)}`);
      return false;
    }
  } catch (err: any) {
    console.error('[WhatsApp Contact Card Error]:', err?.message || err);
    return false;
  }
}

/**
 * Marks incoming WhatsApp message as READ AND triggers native "typing..." indicator (the ..... on user's screen)
 */
export async function sendWhatsAppTypingIndicator(messageId: string): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || config.whatsappAccessToken;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || config.whatsappPhoneNumberId;

  if (!token || !phoneNumberId || !messageId) return false;

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: {
          type: 'text',
        },
      }),
    });
    if (res.ok) {
      pushWaLog(`✓✓ Marked message ${messageId.slice(-8)} as READ + Typing Indicator ON`);
      return true;
    }
  } catch (err: any) {
    console.warn(`[WhatsApp Typing/Read Indicator Error]:`, err?.message || err);
  }
  return false;
}

/**
 * Natural typing delay simulator (1.2s to 3.0s based on message complexity)
 * Mimics real human typing cadences to avoid spam flags and provide natural conversation feel
 */
export async function simulateTypingDelay(ms: number = 1800): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(800, Math.min(ms, 4000))));
}

/**
 * Downloads media (audio voice notes or selfie photos) from Meta Graph API
 */
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN || config.whatsappAccessToken;
  if (!token) return null;

  try {
    const metaUrl = `https://graph.facebook.com/v20.0/${mediaId}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) throw new Error(`Media info failed HTTP ${metaRes.status}`);

    const metaData: any = await metaRes.json();
    const directUrl = metaData?.url;
    const mimeType = metaData?.mime_type || 'image/jpeg';
    if (!directUrl) throw new Error('No direct media URL returned');

    const binaryRes = await fetch(directUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!binaryRes.ok) throw new Error(`Media download failed HTTP ${binaryRes.status}`);

    const arrayBuf = await binaryRes.arrayBuffer();
    return { buffer: Buffer.from(arrayBuf), mimeType };
  } catch (err: any) {
    console.error(`[WhatsApp Media Download Error] Media ${mediaId}:`, err?.message || err);
    return null;
  }
}

/**
 * Meta WhatsApp Webhook GET Verification Handler
 */
export function handleWhatsAppVerification(req: express.Request, res: express.Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || config.whatsappVerifyToken || 'floate_wa_verify_token_2026';

  if (mode === 'subscribe' && token === expectedToken) {
    console.log(`[WhatsApp Webhook Verification] ✅ Verification challenge PASSED.`);
    res.status(200).send(challenge);
  } else {
    console.warn(`[WhatsApp Webhook Verification] ❌ Verification challenge FAILED.`);
    res.status(403).send('Forbidden: Invalid verify token');
  }
}

/**
 * Meta WhatsApp Webhook POST Incoming Messages Ingress Handler
 */
export async function handleWhatsAppWebhook(req: express.Request, res: express.Response) {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const contacts = value?.contacts || [];
        const messages = value?.messages || [];

        for (const message of messages) {
          const senderPhone = message.from; // e.g. "2348012345678"
          const messageId = message.id; // Meta Message ID
          const contact = contacts.find((c: any) => c.wa_id === senderPhone);
          const senderName = contact?.profile?.name || 'Customer';
          const msgType = message.type;

          // 1. Immediately mark message as READ AND trigger WhatsApp native typing indicator (shows the ..... on user's chat)
          if (messageId) {
            sendWhatsAppTypingIndicator(messageId).catch(() => {});
          }

          let rawText = '';
          let audioId: string | null = null;
          let audioMimeType: string = 'audio/ogg';
          let imageId: string | null = null;
          let imageMimeType: string = 'image/jpeg';

          if (msgType === 'text') {
            rawText = message.text?.body || '';
          } else if (msgType === 'interactive') {
            const buttonReply = message.interactive?.button_reply;
            const listReply = message.interactive?.list_reply;
            rawText = buttonReply?.id || listReply?.id || buttonReply?.title || listReply?.title || '';
          } else if (msgType === 'button') {
            rawText = message.button?.payload || message.button?.text || '';
          } else if (msgType === 'audio' || msgType === 'voice') {
            audioId = message.audio?.id || message.voice?.id;
            audioMimeType = message.audio?.mime_type || message.voice?.mime_type || 'audio/ogg';
          } else if (msgType === 'image') {
            imageId = message.image?.id;
            imageMimeType = message.image?.mime_type || 'image/jpeg';
            rawText = message.image?.caption || '';
          }

          // 2. Add realistic human typing delay (1.5s to 2.2s) before generating output
          const typingDelayMs = msgType === 'text' && rawText.length > 20 ? 2200 : 1600;
          await simulateTypingDelay(typingDelayMs);

          // 3. Process message through master state router
          await processMasterWhatsAppEngine({
            senderPhone,
            senderName,
            text: rawText,
            audioId,
            audioMimeType,
            imageId,
            imageMimeType,
          }).catch((err) => {
            console.error(`[WhatsApp Engine Error] +${senderPhone}:`, err);
          });
        }
      }
    }
  } catch (err: any) {
    console.error(`[WhatsApp Ingress Fatal Error]:`, err?.message || err);
  }
}

/**
 * MASTER CONVERSATIONAL ENGINE FOR FLOATE ON WHATSAPP
 */
export async function processMasterWhatsAppEngine(params: {
  senderPhone: string;
  senderName: string;
  text: string;
  audioId?: string | null;
  audioMimeType?: string;
  imageId?: string | null;
  imageMimeType?: string;
}) {
  const { senderPhone, senderName, imageId, imageMimeType } = params;
  let text = params.text.trim();
  const session = getWhatsAppSession(senderPhone);

  // 1. Process Voice Note if present
  if (params.audioId) {
    console.log(`[WhatsApp Voice Note] 🎙️ Processing voice note from +${senderPhone}...`);
    const media = await downloadWhatsAppMedia(params.audioId);
    if (media) {
      try {
        const trans = await transcribeAndAnalyzeAudio(media.buffer, params.audioMimeType || media.mimeType);
        text = trans.transcript?.trim() || '';
        console.log(`[WhatsApp Voice Note] ✅ Transcribed: "${text}"`);
      } catch (err) {
        console.warn('[Voice Transcribe Error]:', err);
      }
    }

    if (!text) {
      const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
      const prefix = name ? `Hello ${name}, ` : 'Hello, ';
      await sendWhatsAppMessage(
        senderPhone,
        `${prefix}we could not clearly hear your voice note. Please type what product, item, or service you are looking for.`
      );
      return;
    }
  }

  const rawLower = text.toLowerCase().trim();
  const cleanLower = rawLower.replace(/[^a-z0-9 _]+/g, '').replace(/\s+/g, ' ');

  // 1. Global Reset / Cancel / Home Interceptor
  if (/^(reset|cancel|stop|exit|start over|restart|home|menu|main menu|\/start|\/cancel|btn_home)$/i.test(cleanLower)) {
    resetWhatsAppSession(senderPhone);
    await firestoreDb.resetUserSession(senderPhone);
    await sendWelcomeGreeting(senderPhone, senderName);
    return;
  }

  // 1b. Location Update Trigger (e.g. "change my location", "update location to Lagos", "set location Abuja")
  const locChangeMatch = cleanLower.match(/^(?:change|update|set|switch)\s+(?:my\s+)?(?:location|city)(?:\s+to\s+(.+))?$/i);
  if (locChangeMatch || /^(my location|change location|update location|switch location)$/i.test(cleanLower)) {
    const inlineLoc = locChangeMatch && locChangeMatch[1] ? locChangeMatch[1].trim() : null;
    if (inlineLoc) {
      await firestoreDb.updateBuyerPrimaryLocation(senderPhone, inlineLoc);
      updateWhatsAppSession(senderPhone, { state: 'IDLE' });
      await sendWhatsAppMessage(
        senderPhone,
        `Your default location has been updated to ${inlineLoc}. What would you like to shop for today?`
      );
      return;
    }
    updateWhatsAppSession(senderPhone, { state: 'AWAITING_LOCATION_CHANGE' });
    await sendWhatsAppMessage(
      senderPhone,
      "What city or area would you like to set as your default location?"
    );
    return;
  }

  // 1c. Handle Active Buyer Location Update / Onboarding Step
  if (session.state === 'AWAITING_LOCATION_CHANGE' || session.state === 'AWAITING_PRIMARY_LOCATION') {
    const cleanLoc = text.trim().replace(/[.,!]/g, '');
    await firestoreDb.updateBuyerPrimaryLocation(senderPhone, cleanLoc);
    const pendingSearch = session.searchState?.lastQuery;
    updateWhatsAppSession(senderPhone, { state: 'IDLE' });

    if (pendingSearch) {
      await sendWhatsAppMessage(
        senderPhone,
        `Your shopping location has been set to ${cleanLoc}. Searching for "${pendingSearch}" near you:`
      );
      await execute10CardSearch(senderPhone, senderName, { queryText: pendingSearch, location: cleanLoc });
    } else {
      await sendWhatsAppMessage(
        senderPhone,
        `Your shopping location has been set to ${cleanLoc}. What would you like to shop for today?`
      );
    }
    return;
  }

  // 1d. Handle Active Role Selection Step (Shopping vs Registering Business)
  if (session.state === 'AWAITING_ROLE_SELECTION') {
    const isRegister = /^(register|sell|vendor|business|merchant|add shop|open shop|list|2)$/i.test(cleanLower);
    const isShopping = /^(shop|shopping|buy|buyer|looking for|find|search|items|products|1)$/i.test(cleanLower);

    if (isRegister) {
      updateWhatsAppSession(senderPhone, { state: 'IDLE' });
      await handleVendorHubRouting(senderPhone, senderName);
      return;
    }

    if (isShopping || cleanLower.length > 1) {
      if (isShopping && cleanLower.length < 12) {
        updateWhatsAppSession(senderPhone, { state: 'AWAITING_PRIMARY_LOCATION' });
        await sendWhatsAppMessage(
          senderPhone,
          "What city or area are you usually shopping from?"
        );
        return;
      } else {
        // User directly typed their search item (e.g. "footwear" or "solar battery")
        updateWhatsAppSession(senderPhone, {
          state: 'AWAITING_PRIMARY_LOCATION',
          searchState: { lastQuery: text, pageIndex: 0, updatedAt: new Date().toISOString() },
        });
        await sendWhatsAppMessage(
          senderPhone,
          "What city or area are you usually shopping from?"
        );
        return;
      }
    }
  }

  // 2. Simple Greeting & Small-Talk Handler (Intercept before buyer search)
  const isGreeting = /^(hi|hi floate|hello|hello floate|hey|hey floate|good morning|good afternoon|good evening|start|\/start)$/i.test(cleanLower);
  if (isGreeting) {
    resetWhatsAppSession(senderPhone);
    await firestoreDb.resetUserSession(senderPhone);
    await sendWelcomeGreeting(senderPhone, senderName);
    return;
  }

  const isSmallTalk = /^(how are you|how are you doing|how far|how body|how are you today)$/i.test(cleanLower);
  if (isSmallTalk) {
    const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
    const prefix = name ? `Hello ${name}, ` : 'Hello, ';
    await sendWhatsAppMessage(
      senderPhone,
      `${prefix}I am doing well, thank you. What would you like to shop for today?`
    );
    return;
  }

  // 3. Deep-Linked Register Business / Vendor Hub / Merchant Portal Trigger (Supports Natural Language)
  if (
    text === 'START_REGISTER_VENDOR' ||
    text === 'btn_for_businesses' ||
    text === 'btn_vendor_portal' ||
    text === 'btn_vendor_dashboard' ||
    /\b(register\s+(my\s+)?(business|store|shop|account|company)|i\s+want\s+to\s+(register|sell|start\s+selling|list\s+my\s+shop|create\s+a\s+shop)|how\s+(can|do)\s+i\s+(register|start\s+selling|sell|list\s+my\s+shop)|create\s+(a\s+)?(business|store|shop)|list\s+my\s+(business|store|shop|company)|sign\s+up\s+(as\s+a\s+)?(merchant|seller|vendor|business)|open\s+(a\s+)?(store|shop)|onboard\s+my\s+(business|shop|store)|become\s+a\s+(seller|vendor|merchant)|sell\s+on\s+floate|merchant\s+registration|vendor\s+registration)\b/i.test(cleanLower) ||
    /^(register|register business|register my business|register shop|start selling|sell|vendor registration|merchant registration|open shop|add my shop|list my shop|vendor|business|vendor hub|merchant|my business|vendor portal|manage|merchant portal|dashboard|my store|store)$/i.test(cleanLower)
  ) {
    await handleVendorHubRouting(senderPhone, senderName);
    return;
  }

  // 4. Vendor Self-Service Direct Action Triggers (Supports Natural Language)
  if (
    text === 'btn_vendor_stats' ||
    /\b(my\s+stats|store\s+stats|business\s+stats|how\s+many\s+searches|view\s+stats|shop\s+performance|business\s+performance|my\s+analytics|how\s+is\s+my\s+shop\s+doing|how\s+is\s+my\s+store\s+performing|how\s+is\s+my\s+business\s+performing)\b/i.test(cleanLower) ||
    /^(stats|view stats|performance|my stats|mystats|my business stats|business stats|store stats|analytics)$/i.test(cleanLower)
  ) {
    await handleVendorStats(senderPhone, senderName);
    return;
  }

  if (
    text === 'btn_vendor_add_product' ||
    /\b(add\s+(a\s+)?(new\s+)?(product|item|listing|stock)|i\s+want\s+to\s+add\s+(a\s+)?(new\s+)?(product|item)|upload\s+(a\s+)?(new\s+)?(product|item)|post\s+(a\s+)?(new\s+)?(product|item)|list\s+(a\s+)?(new\s+)?(product|item))\b/i.test(cleanLower) ||
    /^(add product|addproduct|add item|new product|list product|upload product|add a product|post product|add new product)$/i.test(cleanLower)
  ) {
    await startVendorAddProduct(senderPhone, senderName);
    return;
  }

  if (
    text === 'btn_vendor_edit_products' ||
    /\b(edit\s+(my\s+)?(product|products|item|items|listing|listings|prices|catalog|store)|modify\s+(my\s+)?(product|products|item|items|listing|listings)|update\s+(my\s+)?(product|products|prices|listings)|manage\s+(my\s+)?(products|inventory))\b/i.test(cleanLower) ||
    /^(edit product|edit products|editproduct|edit listings|my inventory|inventory|manage products|edit prices|update product|edit my products)$/i.test(cleanLower)
  ) {
    await startVendorEditProducts(senderPhone, senderName);
    return;
  }

  if (text === 'btn_vendor_delete_account' || /^(delete account|delete store|deactivate store|deactivate account)$/i.test(cleanLower)) {
    await startVendorDeleteAccount(senderPhone, senderName);
    return;
  }

  if (text === 'btn_confirm_delete_account' || session.state === 'VENDOR_DELETE_CONFIRM') {
    await handleVendorDeleteAccountConfirm(senderPhone, senderName, text);
    return;
  }

  // 5. Active Vendor Portal Sessions
  if (session.state === 'VENDOR_PORTAL') {
    if (cleanLower === '1' || cleanLower === 'stats' || cleanLower === 'view stats') {
      await handleVendorStats(senderPhone, senderName);
      return;
    } else if (cleanLower === '2' || cleanLower === 'add' || cleanLower === 'add product') {
      await startVendorAddProduct(senderPhone, senderName);
      return;
    } else if (cleanLower === '3' || cleanLower === 'edit' || cleanLower === 'edit listings') {
      await startVendorEditProducts(senderPhone, senderName);
      return;
    } else if (cleanLower === '4' || cleanLower === 'delete' || cleanLower === 'delete store') {
      await startVendorDeleteAccount(senderPhone, senderName);
      return;
    }
  }

  if (session.state === 'VENDOR_ADD_PRODUCT') {
    await handleVendorAddProductStep(senderPhone, senderName, text, session);
    return;
  }

  if (session.state === 'VENDOR_EDIT_PRODUCTS') {
    await handleVendorEditProductsStep(senderPhone, senderName, text, session);
    return;
  }

  // 6. Deep-Linked Connect Vendor Selection (e.g. CONNECT_VENDOR_123, connect_biz_123, connect_lead_123)
  if (
    text.startsWith('connect_biz_') ||
    text.startsWith('connect_lead_') ||
    text.startsWith('connect_vendor_') ||
    text.startsWith('CONNECT_VENDOR_') ||
    /^connect\s+vendor\s+[a-z0-9_-]+/i.test(text)
  ) {
    const bizId = text.replace(/^(connect_biz_|connect_lead_|connect_vendor_|CONNECT_VENDOR_|connect\s+vendor\s+)/i, '').trim();
    await start2StepLeadQualification(senderPhone, senderName, bizId);
    return;
  }

  // 7. Deep-Linked Search Query (e.g. SEARCH_shoes_in_onitsha)
  if (text.startsWith('SEARCH_') || text.startsWith('search_')) {
    const sq = text.replace(/^(SEARCH_|search_)/, '').replace(/_/g, ' ').trim();
    await execute5CardSearch(senderPhone, senderName, { queryText: sq });
    return;
  }

  // 8. Number selection (1-10), ordinal, or business name selection from active search results
  if (session.searchState?.allMatchingListings && session.searchState.allMatchingListings.length > 0) {
    const listings = session.searchState.allMatchingListings;
    const pageOffset = (session.searchState.pageIndex || 0) * 10;
    const currentBatch = listings.slice(pageOffset, pageOffset + 10);

    // Check numerical selection: "1", "2" ... "10", "option 1", "first one", "second vendor", etc.
    const ordinalMap: Record<string, number> = {
      'first': 1, '1st': 1, 'one': 1, '1': 1,
      'second': 2, '2nd': 2, 'two': 2, '2': 2,
      'third': 3, '3rd': 3, 'three': 3, '3': 3,
      'fourth': 4, '4th': 4, 'four': 4, '4': 4,
      'fifth': 5, '5th': 5, 'five': 5, '5': 5,
      'sixth': 6, '6th': 6, 'six': 6, '6': 6,
      'seventh': 7, '7th': 7, 'seven': 7, '7': 7,
      'eighth': 8, '8th': 8, 'eight': 8, '8': 8,
      'ninth': 9, '9th': 9, 'nine': 9, '9': 9,
      'tenth': 10, '10th': 10, 'ten': 10, '10': 10,
    };

    let selectedIdx = -1;

    // Check if message says "first vendor", "number 2", "select 3", etc.
    for (const [key, num] of Object.entries(ordinalMap)) {
      const regex = new RegExp(`(^|\\b)(vendor|shop|option|number|no|no\\.|select|choose|connect|chat with)?\\s*${key}(\\b|$)`, 'i');
      if (regex.test(cleanLower)) {
        selectedIdx = pageOffset + (num - 1);
        break;
      }
    }

    // If not matched by number, check natural language match against vendor business name or keywords
    if (selectedIdx === -1) {
      for (let i = 0; i < currentBatch.length; i++) {
        const item = currentBatch[i];
        const bizNameClean = (item.businessName || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '');
        const itemClean = (item.product || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '');
        
        // Exact name match or substring of vendor name
        if (
          (bizNameClean && (cleanLower.includes(bizNameClean) || bizNameClean.includes(cleanLower))) ||
          (cleanLower.startsWith('connect ') && cleanLower.includes(bizNameClean.split(' ')[0])) ||
          (cleanLower.startsWith('i want ') && cleanLower.includes(bizNameClean.split(' ')[0]))
        ) {
          selectedIdx = pageOffset + i;
          break;
        }
      }
    }

    if (selectedIdx >= 0 && selectedIdx < listings.length) {
      const selectedListing = listings[selectedIdx];
      if (selectedListing) {
        await start3StepLeadQualification(senderPhone, senderName, selectedListing.id);
        return;
      }
    }
  }

  // 9. Find a Product Intent Trigger (Direct prompt instead of generic search)
  if (
    text === 'btn_find_product' ||
    /^(find a product|search product|search products|find product|find products|search for a product|search sellers|buy something|shop for something)$/i.test(cleanLower)
  ) {
    resetWhatsAppSession(senderPhone);
    const firstName = senderName && senderName !== 'Customer' ? senderName.split(' ')[0] : 'there';
    await sendWhatsAppMessage(
      senderPhone,
      `Alright ${firstName}, what product would you like to find?\n\n` +
      `💬 _You can type any item, brand, or location (e.g. "Leather shoes in Onitsha", "iPhone 13 128GB", or "Solar inverter") or send a quick voice note._`
    );
    return;
  }

  // 5. Report Vendor Flow Trigger
  if (text.startsWith('report_vendor_') || text === 'btn_report_vendor' || cleanLower === 'report' || cleanLower === 'report vendor') {
    const targetVendorId = text.startsWith('report_vendor_') ? text.replace('report_vendor_', '').trim() : '';
    const vendorListing = targetVendorId ? sheetsDb.getListingById(targetVendorId) : null;
    const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
    const prefix = name ? `Hello ${name}, ` : 'Hello, ';

    updateWhatsAppSession(senderPhone, {
      state: 'REPORT_PROCESS',
      reportDraft: {
        step: 'AWAITING_DETAILS',
        vendorId: targetVendorId || session.activeVendorId || '',
        vendorName: vendorListing?.businessName || session.activeVendorName || '',
        vendorPhone: vendorListing?.whatsapp || session.activeVendorPhone || '',
        updatedAt: new Date().toISOString(),
      },
    });

    const vendorMention = vendorListing?.businessName || session.activeVendorName ? ` regarding ${vendorListing?.businessName || session.activeVendorName}` : '';
    await sendWhatsAppMessage(
      senderPhone,
      `${prefix}I am sorry to hear you are having an issue${vendorMention}. Please tell me what happened, what the vendor did, and the vendor's name or phone number so we can look into it for you.`
    );
    return;
  }

  // Handle active REPORT_PROCESS
  if (session.state === 'REPORT_PROCESS' && session.reportDraft?.step === 'AWAITING_DETAILS') {
    const isFraudOrScam = /\b(scam|scammer|fraud|fake|cheat|cheated|stole|stolen|thief|money|swindled|refused to deliver|paid but|never sent|blocked me|fake receipt|impersonat)\b/i.test(text);

    const reportId = await submitVendorReport({
      reporterPhone: senderPhone,
      reporterName: senderName,
      vendorId: session.reportDraft.vendorId,
      vendorName: session.reportDraft.vendorName,
      vendorPhone: session.reportDraft.vendorPhone,
      reason: text,
      isFraudOrScam,
    });

    resetWhatsAppSession(senderPhone);
    const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
    const prefix = name ? `Hello ${name}, ` : 'Hello, ';

    if (isFraudOrScam) {
      await sendWhatsAppMessage(
        senderPhone,
        `${prefix}I completely understand how frustrating and concerning this is. We take issues like this very seriously. Your report has been escalated directly to the Floate Security Team to handle, and they will review the details and reach out to you on WhatsApp. Everything will be thoroughly investigated and addressed.`
      );
    } else {
      await sendWhatsAppMessage(
        senderPhone,
        `${prefix}I am very sorry for the inconvenience this has caused you. We have received your report and our management team will investigate this vendor thoroughly to ensure this is resolved. Thank you for bringing this to our attention.`
      );
    }
    return;
  }

  // 5. Vendor Hub / "For Businesses" Intent Trigger
  if (text === 'btn_for_businesses' || /^(register|register my business|vendor|business|vendor hub|merchant|add my shop)$/i.test(cleanLower)) {
    await handleVendorHubRouting(senderPhone, senderName);
    return;
  }

  // 6. Claim Existing Shop Intent
  if (text === 'btn_claim_shop' || text.startsWith('claim_biz_') || cleanLower === 'claim') {
    await startClaimBusinessFlow(senderPhone, senderName);
    return;
  }

  // Handle active CLAIM_PROCESS
  if (session.state === 'CLAIM_PROCESS') {
    await handleClaimProcessSteps(senderPhone, senderName, text, session);
    return;
  }

  // 7. Conversational 6-Step Vendor Registration Flow
  if (text === 'btn_start_registration') {
    await startConversationalRegistration(senderPhone, senderName);
    return;
  }

  if (session.state === 'REG_ONBOARDING') {
    await handleRegistrationSteps(senderPhone, senderName, text, imageId, imageMimeType, session);
    return;
  }

  // 8. Browse Markets Intent Trigger
  if (text === 'btn_browse_markets' || cleanLower === 'browse markets' || cleanLower === 'markets') {
    await sendMarketHubsMenu(senderPhone);
    return;
  }

  // Market Selection Clicked from List Menu (e.g. market_onitsha_main, market_lagos_balogun)
  if (text.startsWith('market_')) {
    const marketKey = text.replace('market_', '');
    const marketNameMap: Record<string, string> = {
      onitsha_main: 'Main Market, Onitsha',
      onitsha_bridgehead: 'Bridge Head Market, Onitsha',
      lagos_computervillage: 'Computer Village, Ikeja, Lagos',
      lagos_balogun: 'Balogun Market, Lagos Island',
      lagos_alaba: 'Alaba International Market, Lagos',
      lagos_tradefair: 'Trade Fair Complex, Lagos',
      aba_ariaria: 'Ariaria International Market, Aba',
      kano_kantinkwari: 'Kantin Kwari Market, Kano',
      abuja_wuse: 'Wuse Market, Abuja',
    };
    const targetLoc = marketNameMap[marketKey] || 'Nigeria';
    await execute10CardSearch(senderPhone, senderName, { queryText: 'Popular wholesale & retail items', location: targetLoc });
    return;
  }

  // 9. Interactive Category Chip Selection (e.g. chip_shoes_women, chip_shoes_men, chip_phones_iphone)
  if (text.startsWith('chip_')) {
    const chipQuery = text.replace('chip_', '').replace(/_/g, ' ');
    await execute10CardSearch(senderPhone, senderName, { queryText: chipQuery });
    return;
  }

  // 10. Show Next 10 Vendors Pagination
  if (
    text === 'btn_next_10_vendors' ||
    text === 'btn_next_5_vendors' ||
    cleanLower === 'next 10' ||
    cleanLower === 'next' ||
    cleanLower === 'show next'
  ) {
    await handleShowNext10Vendors(senderPhone, senderName, session);
    return;
  }

  // 11. Vendor Selection & 3-Step Lead Qualification
  if (text.startsWith('connect_biz_') || text.startsWith('connect_')) {
    const bizId = text.replace(/^(connect_biz_|connect_)/, '').trim();
    await start3StepLeadQualification(senderPhone, senderName, bizId);
    return;
  }

  // Step 1: Order Volume Answered -> Go to Step 2 (Fulfillment)
  if (session.state === 'QUALIFYING_VOLUME') {
    if (
      text.startsWith('vol_') ||
      /^(retail|wholesale|personal|bulk|resell|sample)$/i.test(cleanLower) ||
      /^(retail order|personal retail|wholesale order|bulk order)$/i.test(cleanLower)
    ) {
      const volChoice: 'Retail' | 'Wholesale' =
        /wholesale|bulk|resell/i.test(cleanLower) || text === 'vol_wholesale' ? 'Wholesale' : 'Retail';

      updateWhatsAppSession(senderPhone, {
        state: 'QUALIFYING_FULFILLMENT',
        orderVolume: volChoice,
      });

      await sendWhatsAppMessage(
        senderPhone,
        `📍 *Step 2 of 3: Fulfillment & Delivery Preference*\n\n` +
        `How would you like to receive your item from *${session.activeVendorName}*?\n\n` +
        `1️⃣ *Physical Shop Visit* (Walk in & inspect)\n` +
        `2️⃣ *Local City Delivery* (Dispatch to doorstep)\n` +
        `3️⃣ *Interstate Waybill* (Interstate logistics)`,
        {
          quickReplies: [
            { id: 'ful_visit', title: '📍 Shop Visit' },
            { id: 'ful_delivery', title: '🚚 City Delivery' },
            { id: 'ful_waybill', title: '📦 Interstate Waybill' },
          ],
        }
      );
      return;
    } else if (!text.startsWith('vol_') && cleanLower.length > 2) {
      // If user typed a completely different product or question instead of answering volume, cancel qualification and search
      resetWhatsAppSession(senderPhone);
      await execute10CardSearch(senderPhone, senderName, { queryText: text });
      return;
    }
  }

  // Step 2: Fulfillment Answered -> Go to Step 3 (Buyer Location)
  if (session.state === 'QUALIFYING_FULFILLMENT') {
    if (
      text.startsWith('ful_') ||
      /^(visit|delivery|waybill|interstate|shop|dispatch|pickup|doorstep|way bill)$/i.test(cleanLower) ||
      /^(shop visit|city delivery|interstate waybill)$/i.test(cleanLower)
    ) {
      let fulChoice: 'Shop Visit' | 'Local City Delivery' | 'Interstate Waybill' = 'Local City Delivery';
      if (text === 'ful_visit' || /visit|shop|pickup|in person/i.test(cleanLower)) {
        fulChoice = 'Shop Visit';
      } else if (text === 'ful_waybill' || /waybill|interstate|way bill/i.test(cleanLower)) {
        fulChoice = 'Interstate Waybill';
      }

      updateWhatsAppSession(senderPhone, {
        state: 'QUALIFYING_LOCATION',
        fulfillment: fulChoice,
      });

      await sendWhatsAppMessage(
        senderPhone,
        `📍 *Step 3 of 3: Buyer Location*\n\n` +
        `Which city or state are you shopping from?\n\n` +
        `_Tap a common city below, or simply reply with your city name (e.g. \`Enugu\`, \`Ibadan\`, \`Asaba\`, \`Kano\`):_`,
        {
          quickReplies: [
            { id: 'loc_lagos', title: '📍 Lagos' },
            { id: 'loc_abuja', title: '📍 Abuja' },
            { id: 'loc_ph', title: '📍 Port Harcourt' },
          ],
        }
      );
      return;
    } else if (!text.startsWith('ful_') && cleanLower.length > 2) {
      // If user typed a completely new search term instead of answering delivery, cancel and execute search
      resetWhatsAppSession(senderPhone);
      await execute10CardSearch(senderPhone, senderName, { queryText: text });
      return;
    }
  }

  // Step 3: Buyer Location Answered -> Save Lead to DB & Complete Handoff
  if (session.state === 'QUALIFYING_LOCATION') {
    let buyerLoc = text.trim();
    if (text === 'loc_lagos' || cleanLower.includes('lagos')) {
      buyerLoc = 'Lagos';
    } else if (text === 'loc_abuja' || cleanLower.includes('abuja')) {
      buyerLoc = 'Abuja';
    } else if (text === 'loc_ph' || cleanLower.includes('port harcourt') || cleanLower.includes('ph')) {
      buyerLoc = 'Port Harcourt';
    } else if (text.startsWith('loc_')) {
      buyerLoc = text.replace('loc_', '').replace(/_/g, ' ');
    }

    await finish3StepQualificationHandoff(senderPhone, senderName, buyerLoc, session);
    return;
  }

  // 12. Execute Natural Language Search Query directly
  await execute10CardSearch(senderPhone, senderName, {
    queryText: text,
  });
}

/**
 * 1. THE NATIVE WELCOME GREETING
 */
async function sendWelcomeGreeting(toPhone: string, senderName: string) {
  const session = getWhatsAppSession(toPhone);
  const buyer = await firestoreDb.getOrCreateBuyerAccount(toPhone, 'whatsapp', senderName);
  const alreadySeenTip = session.hasSeenSaveTip || (await firestoreDb.hasUserSeenSaveTip(toPhone));

  const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
  const prefix = name ? `Hello ${name}, ` : 'Hello, ';

  let msg = '';
  if (!alreadySeenTip && !buyer.primaryLocation) {
    // First-time greeting for new numbers with full guidelines, support email, save tip, and Role question
    msg = `${prefix}welcome to Floate. You can find verified vendors and products across Nigeria by simply typing what you want, registering your business, or asking for help. To report a business or contact support, email us at support@floate.xyz. Please save this number as Floate for quick access anytime.\n\nAre you shopping with Floate or would you like to register your business with Floate?`;

    updateWhatsAppSession(toPhone, { state: 'AWAITING_ROLE_SELECTION', hasSeenSaveTip: true });
    await firestoreDb.markUserSeenSaveTip(toPhone);
  } else if (!buyer.primaryLocation) {
    updateWhatsAppSession(toPhone, { state: 'AWAITING_PRIMARY_LOCATION' });
    msg = `${prefix}what city or area are you usually shopping from?`;
  } else {
    // Returning user greeting (Clean & uncluttered straight line without emojis, paragraphs, or buttons)
    msg = `${prefix}what would you like to shop for today?`;
  }

  await sendWhatsAppMessage(toPhone, msg);
}

/**
 * 2. 10-BUSINESS SEARCH & DISCOVERY ENGINE (Spotlight Priority with Organic Fallback)
 */
async function execute10CardSearch(toPhone: string, senderName: string, params: { queryText: string; location?: string }) {
  const { queryText, location } = params;

  // 1. AI Parsing with Gemini
  let parsed;
  try {
    parsed = await parseShoppingQuery(queryText);
  } catch {
    parsed = { searchKeywords: queryText, targetSellerLocation: location };
  }

  const cleanProduct = parsed.searchKeywords || queryText;

  // Resolve buyer account & location hierarchy:
  // 1. Query override (e.g. "shoes in onitsha") takes highest precedence for this search
  // 2. Otherwise default to buyer's saved primaryLocation for proximity prioritization
  const buyer = await firestoreDb.getOrCreateBuyerAccount(toPhone, 'whatsapp', senderName);
  const targetLoc = location || parsed.targetSellerLocation || buyer.primaryLocation || undefined;

  // Check if query is broad and could benefit from Dynamic Sub-Category Chips
  const lowerQuery = cleanProduct.toLowerCase();
  if (lowerQuery === 'shoes' || lowerQuery === 'footwear') {
    await sendWhatsAppMessage(
      toPhone,
      `👠 *Narrow down your footwear search for faster matches:*\n\nWhat type of shoes are you looking for?`,
      {
        quickReplies: [
          { id: 'chip_women_sandals_heels', title: '👡 Women Sandals' },
          { id: 'chip_men_corporate_loafers', title: '👞 Men Corporate' },
          { id: 'chip_sneakers_casual_shoes', title: '👟 Sneakers' },
        ],
      }
    );
    return;
  } else if (lowerQuery === 'phone' || lowerQuery === 'phones') {
    await sendWhatsAppMessage(
      toPhone,
      `📱 *Narrow down your phone search:*\n\nWhich device are you interested in?`,
      {
        quickReplies: [
          { id: 'chip_iphone_13_14_15', title: '🍏 Apple iPhone' },
          { id: 'chip_samsung_galaxy', title: '📱 Samsung Galaxy' },
          { id: 'chip_uk_used_phones', title: '📦 UK Used / Tokunbo' },
        ],
      }
    );
    return;
  } else if (lowerQuery === 'solar' || lowerQuery === 'inverter') {
    await sendWhatsAppMessage(
      toPhone,
      `☀️ *Solar & Power Inverters:*\n\nWhat capacity or component do you need?`,
      {
        quickReplies: [
          { id: 'chip_3.5kva_5kva_inverter', title: '⚡ 3.5kVA / 5kVA' },
          { id: 'chip_lithium_battery', title: '🔋 Lithium Battery' },
          { id: 'chip_complete_solar_setup', title: '☀️ Complete Setup' },
        ],
      }
    );
    return;
  }

  // 2. Query Firestore / Google Sheets for matching verified businesses
  let searchResults;
  try {
    searchResults = await sheetsDb.searchBusinessListings(
      cleanProduct,
      targetLoc,
      parsed.category,
      parsed.maxPriceNaira,
      parsed.inferredCategories
    );
  } catch (err) {
    console.error('[Search Error]:', err);
    searchResults = { exactMatches: [], categoryMatches: [], allMatches: [], source: 'local' as const };
  }

  const rawMatches = [
    ...searchResults.exactMatches,
    ...searchResults.categoryMatches,
    ...(searchResults.outOfAreaRecommendations || []),
  ];

  // Deduplicate matches by ID
  const seenIds = new Set<string>();
  const uniqueMatches: BusinessListing[] = [];
  for (const m of rawMatches) {
    if (m && m.id && !seenIds.has(m.id)) {
      seenIds.add(m.id);
      uniqueMatches.push(m);
    }
  }

  // SCENARIO: No matching sellers found
  if (uniqueMatches.length === 0) {
    await sendWhatsAppMessage(
      toPhone,
      `🔍 *Search Results for:* "${cleanProduct}"\n\n` +
      `No verified sellers are currently active for this item in our immediate directory.\n\n` +
      `💡 *Suggestions:*\n` +
      `• Try searching a broader term (e.g. \`Leather Slippers\` or \`Solar Battery\`).\n` +
      `• Browse top commercial market hubs below:`,
      {
        quickReplies: [
          { id: 'btn_browse_markets', title: '📍 Browse Markets' },
          { id: 'btn_find_product', title: '🔍 New Search' },
          { id: 'btn_home', title: '🏠 Main Menu' },
        ],
      }
    );
    return;
  }

  // 3. Spotlight Prioritization with Organic Fallback:
  const spotlightMatches: BusinessListing[] = [];
  const organicMatches: BusinessListing[] = [];

  for (const item of uniqueMatches) {
    if (isSpotlightBusiness(item.businessName) || item.isHighlyRecommended) {
      spotlightMatches.push(item);
    } else {
      organicMatches.push(item);
    }
  }

  // Prioritize Spotlight listings first, then Organic matches as fallback
  const prioritizedListings = [...spotlightMatches, ...organicMatches];

  // Record search history for persistent buyer profile
  await firestoreDb.recordBuyerSearch(toPhone, cleanProduct, targetLoc, uniqueMatches.length);

  // Take top 10 for the primary view
  const primaryDisplay = prioritizedListings.slice(0, 10);

  // Save in user session state for pagination / selection
  updateWhatsAppSession(toPhone, {
    state: 'IDLE',
    searchState: {
      lastQuery: queryText,
      cleanProduct,
      location: targetLoc,
      category: parsed.category || '',
      allMatchingListings: prioritizedListings,
      pageIndex: 0,
      updatedAt: new Date().toISOString(),
    },
  });

  const spotlightInPrimary = primaryDisplay.filter(v => isSpotlightBusiness(v.businessName) || v.isHighlyRecommended);
  const organicInPrimary = primaryDisplay.filter(v => !(isSpotlightBusiness(v.businessName) || v.isHighlyRecommended));

  const locNotice = targetLoc ? ` in *${targetLoc}*` : '';
  let previewMsg = `🔍 *Businesses matching "${cleanProduct}"${locNotice}:*\n\n`;

  if (spotlightInPrimary.length > 0) {
    previewMsg += `*Top Spotlight Businesses*\n\n`;
    for (let i = 0; i < spotlightInPrimary.length; i++) {
      const v = spotlightInPrimary[i];
      const idx = primaryDisplay.indexOf(v) + 1;
      const priceDisplay = v.price || 'Market Rate';
      previewMsg += `${idx}. *${v.businessName}* — ${v.product} (${priceDisplay})\n\n`;
    }
  }

  if (organicInPrimary.length > 0) {
    if (spotlightInPrimary.length > 0) {
      previewMsg += `*Verified Vendors*\n\n`;
    }
    for (let i = 0; i < organicInPrimary.length; i++) {
      const v = organicInPrimary[i];
      const idx = primaryDisplay.indexOf(v) + 1;
      const priceDisplay = v.price || 'Market Rate';
      previewMsg += `${idx}. *${v.businessName}* — ${v.product} (${priceDisplay})\n\n`;
    }
  }

  previewMsg +=
    `────────────────────\n` +
    `💡 *How to select:*\n` +
    `• Tap *"Select Vendor"* below, OR\n` +
    `• Reply with the number (e.g. \`1\`, \`2\`, \`3\`) or business name`;

  // Build Native Slide-Up List Menu
  const menuSections: WhatsAppListSection[] = [];

  if (spotlightInPrimary.length > 0) {
    menuSections.push({
      title: 'Top Spotlight Businesses',
      rows: spotlightInPrimary.map((v) => {
        const fullIdx = primaryDisplay.findIndex(p => p.id === v.id) + 1;
        return {
          id: `connect_biz_${v.id}`,
          title: `${fullIdx}. ${v.businessName}`.substring(0, 24),
          description: `${v.product} • ${v.price || 'Best Price'}`.substring(0, 72),
        };
      }),
    });
  }

  if (organicInPrimary.length > 0) {
    menuSections.push({
      title: 'Verified Vendors',
      rows: organicInPrimary.map((v) => {
        const fullIdx = primaryDisplay.findIndex(p => p.id === v.id) + 1;
        return {
          id: `connect_biz_${v.id}`,
          title: `${fullIdx}. ${v.businessName}`.substring(0, 24),
          description: `${v.product} • ${v.price || 'Best Price'}`.substring(0, 72),
        };
      }),
    });
  }

  // If fewer than 10 total vendors are displayed, optionally fill remaining slots with quick action rows
  const currentTotalRows = spotlightInPrimary.length + organicInPrimary.length;
  const remainingSlots = 10 - currentTotalRows;

  if (remainingSlots > 0) {
    const quickRows: Array<{ id: string; title: string; description?: string }> = [];
    if (prioritizedListings.length > 10) {
      quickRows.push({
        id: 'btn_next_10_vendors',
        title: '➡️ Next 10 Vendors',
        description: `View remaining (${prioritizedListings.length - 10} more sellers)`,
      });
    }
    quickRows.push({
      id: 'btn_find_product',
      title: '🔍 New Search',
      description: 'Search for a different product',
    });
    quickRows.push({
      id: 'btn_home',
      title: '🏠 Main Menu',
      description: 'Return to Floate home menu',
    });

    menuSections.push({
      title: '⚡ Quick Actions',
      rows: quickRows.slice(0, remainingSlots),
    });
  }

  await sendWhatsAppMessage(toPhone, previewMsg, {
    listMenu: {
      buttonText: '📋 Select Vendor',
      title: 'Verified Vendors',
      sections: menuSections,
    },
  });
}

// Alias for backward compatibility
const execute5CardSearch = execute10CardSearch;

/**
 * Handle Next 10 Vendors Pagination
 */
async function handleShowNext10Vendors(toPhone: string, senderName: string, session: any) {
  const search = session.searchState;
  if (!search || !search.allMatchingListings || search.allMatchingListings.length === 0) {
    await sendWelcomeGreeting(toPhone, senderName);
    return;
  }

  const nextPage = (search.pageIndex || 0) + 1;
  const startIdx = nextPage * 10;
  const next10 = search.allMatchingListings.slice(startIdx, startIdx + 10);

  if (next10.length === 0) {
    await sendWhatsAppMessage(
      toPhone,
      `🏁 *You've viewed all ${search.allMatchingListings.length} verified vendors for "${search.cleanProduct}".*\n\nWould you like to try another market or search a new item?`,
      {
        quickReplies: [
          { id: 'btn_browse_markets', title: '📍 Browse Markets' },
          { id: 'btn_find_product', title: '🔍 New Search' },
          { id: 'btn_home', title: '🏠 Main Menu' },
        ],
      }
    );
    return;
  }

  updateWhatsAppSession(toPhone, {
    searchState: {
      ...search,
      pageIndex: nextPage,
      updatedAt: new Date().toISOString(),
    },
  });

  let previewMsg =
    `🔍 *Showing Vendors ${startIdx + 1}–${startIdx + next10.length} of ${search.allMatchingListings.length} for "${search.cleanProduct}":*\n\n`;

  for (let i = 0; i < next10.length; i++) {
    const v = next10[i];
    const priceDisplay = v.price || 'Market Rate';
    previewMsg += `${startIdx + i + 1}. *${v.businessName}* — ${v.product} (${priceDisplay})\n\n`;
  }

  previewMsg +=
    `────────────────────\n` +
    `💡 *How to select:*\n` +
    `• Tap *"Select Vendor"* below, OR\n` +
    `• Reply with the number or business name`;

  const listRows = next10.slice(0, 10).map((v: any, idx: number) => ({
    id: `connect_biz_${v.id}`,
    title: `${startIdx + idx + 1}. ${v.businessName}`.substring(0, 24),
    description: `${v.product} • ${v.price || 'Best Price'}`.substring(0, 72),
  }));

  const menuSections: WhatsAppListSection[] = [
    {
      title: `Verified Vendors (${startIdx + 1}–${startIdx + next10.length})`,
      rows: listRows,
    },
  ];

  await sendWhatsAppMessage(toPhone, previewMsg, {
    listMenu: {
      buttonText: '📋 Select Vendor',
      title: 'Verified Vendors',
      sections: menuSections,
    },
  });
}

// Alias for backward compatibility
const handleShowNext5Vendors = handleShowNext10Vendors;

/**
 * 3. 3-STEP LEAD QUALIFICATION & SELLER HANDOFF
 */
async function start3StepLeadQualification(toPhone: string, senderName: string, bizId: string) {
  const listing = sheetsDb.getListingById(bizId);
  const bizName = listing?.businessName || 'Verified Vendor';
  const bizPhone = listing?.whatsapp || '';
  const item = listing?.product || 'Items';

  updateWhatsAppSession(toPhone, {
    state: 'QUALIFYING_VOLUME',
    activeVendorId: bizId,
    activeVendorName: bizName,
    activeVendorPhone: bizPhone,
    activeItem: item,
  });

  await sendWhatsAppMessage(
    toPhone,
    `🎯 *Connecting you with ${bizName}...*\n\n` +
    `*Step 1 of 3: Are you buying for personal use or wholesale / bulk?*`,
    {
      quickReplies: [
        { id: 'vol_retail', title: '🛍️ Personal / Retail' },
        { id: 'vol_wholesale', title: '📦 Wholesale / Bulk' },
      ],
    }
  );
}

// Alias for backward compatibility
const start2StepLeadQualification = start3StepLeadQualification;

async function finish3StepQualificationHandoff(
  toPhone: string,
  senderName: string,
  buyerLocation: string,
  session: any
) {
  const bizName = session.activeVendorName || 'Verified Vendor';
  const rawBizPhone = session.activeVendorPhone || '';
  const cleanBizPhone = normalizePhone(rawBizPhone).replace(/^0/, '234');
  const item = session.activeItem || 'In-Stock Goods';
  const volume = session.orderVolume || 'Retail';
  const fulfillment = session.fulfillment || 'Local City Delivery';
  const location = buyerLocation || session.buyerLocation || 'Nigeria';

  // Save qualified lead to Firestore for seller analytics & conversion tracking
  try {
    await firestoreDb.recordWhatsAppLead({
      buyerPhone: toPhone,
      buyerName: senderName,
      merchantId: session.activeVendorId || '',
      merchantName: bizName,
      merchantWhatsapp: rawBizPhone,
      item,
      orderVolume: volume,
      fulfillment,
      buyerLocation: location,
    });
  } catch (err) {
    console.error('[WhatsApp Lead Record Error]:', err);
  }

  // Build clean pre-filled WhatsApp message: HI [BUSINESS NAME], I found you on FLOATE.
  const prefilledText = `HI ${bizName.toUpperCase()}, I found you on FLOATE.`;
  const waLink = `https://wa.me/${cleanBizPhone}?text=${encodeURIComponent(prefilledText)}`;

  resetWhatsAppSession(toPhone);

  const buyerCleanPhone = toPhone.replace(/\D/g, '');
  const referralLink = `https://floate.xyz/?ref=${encodeURIComponent(buyerCleanPhone)}`;

  const handoffMsg =
    `✅ *Verified Seller Ready to Connect*\n\n` +
    `🟢 *Status:* Verified Active Merchant\n` +
    `🏬 *Vendor:* ${bizName}\n` +
    `📦 *Item:* ${item}\n` +
    `🛍️ *Order Type:* ${volume}\n` +
    `🚚 *Fulfillment:* ${fulfillment}\n` +
    `📍 *Buyer Location:* ${location}\n\n` +
    `👉 *Connect to vendor:*\n` +
    `Tap the button below to message ${bizName} directly on WhatsApp:\n\n` +
    `⚠️ *Buyer Safety:* _Always inspect items or agree on safe payment before sending money. FLOATE connects buyers and sellers with zero commission._\n\n` +
    `🎁 *Know someone who'd love this?* Share Floate with them: ${referralLink}`;

  await sendWhatsAppMessage(toPhone, handoffMsg, {
    ctaUrl: {
      displayText: '💬 Message Vendor',
      url: waLink,
      headerText: '🛍️ Direct Vendor Handoff',
      footerText: 'Zero Commission • FLOATE Trade',
    },
  });
}

// Alias for backward compatibility
const finish2StepQualificationHandoff = (toPhone: string, senderName: string, ful: any, session: any) =>
  finish3StepQualificationHandoff(toPhone, senderName, 'Nigeria', { ...session, fulfillment: ful });

/**
 * 4. MARKET HUBS MENU
 */
async function sendMarketHubsMenu(toPhone: string) {
  await sendWhatsAppMessage(
    toPhone,
    `📍 *Select a Major Commercial Market Hub:*\n\nTap "View Market Hubs" below to explore verified shops in Lagos, Onitsha, Aba, Kano, and Abuja:`,
    {
      listMenu: {
        buttonText: '📍 View Market Hubs',
        title: 'Commercial Trade Hubs',
        sections: [
          {
            title: '🏙️ Anambra / East',
            rows: [
              { id: 'market_onitsha_main', title: 'Main Market, Onitsha', description: 'Wholesale fashion, textiles & provisions' },
              { id: 'market_onitsha_bridgehead', title: 'Bridge Head, Onitsha', description: 'Tools, hardware, leather & chemicals' },
              { id: 'market_aba_ariaria', title: 'Ariaria Market, Aba', description: 'Made-in-Aba shoes, bags, garments' },
            ],
          },
          {
            title: '🏙️ Lagos Trade Hubs',
            rows: [
              { id: 'market_lagos_computervillage', title: 'Computer Village, Ikeja', description: 'Phones, laptops, gadgets & repairs' },
              { id: 'market_lagos_balogun', title: 'Balogun / Idumota Market', description: 'Wholesale lace, fabrics, shoes & jewelry' },
              { id: 'market_lagos_alaba', title: 'Alaba Int. Market', description: 'Electronics, solar inverters, sound systems' },
              { id: 'market_lagos_tradefair', title: 'Trade Fair Complex', description: 'Cosmetics, general goods & auto parts' },
            ],
          },
          {
            title: '🏙️ North & Federal',
            rows: [
              { id: 'market_kano_kantinkwari', title: 'Kantin Kwari, Kano', description: 'African textile & wholesale fabrics' },
              { id: 'market_abuja_wuse', title: 'Wuse / UTC, Abuja', description: 'Corporate services, electronics & fashion' },
            ],
          },
        ],
      },
    }
  );
}

/**
 * 5. VENDOR HUB & MERCHANT PORTAL (Self-Service Dashboard)
 */
async function handleVendorHubRouting(toPhone: string, senderName: string) {
  // Check if sender phone matches a registered vendor in Firestore or Sheets
  let existingMerchant = await firestoreDb.getMerchant(toPhone);
  if (!existingMerchant) {
    const sheetListing = sheetsDb.getListingByPhone(toPhone);
    if (sheetListing) {
      existingMerchant = {
        id: sheetListing.id,
        businessName: sheetListing.businessName,
        ownerFullName: sheetListing.ownerFullName,
        whatsapp: sheetListing.whatsapp,
        city: sheetListing.city,
        state: sheetListing.state,
        category: sheetListing.category,
        credit_balance: 1000,
        status: 'ACTIVE',
        isVerified: sheetListing.isVerified,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  // SCENARIO A: Existing Registered Vendor -> Auto Phone Recognition & Merchant Dashboard
  if (existingMerchant && existingMerchant.businessName) {
    updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL' });
    const stats = await firestoreDb.getMerchantStats(toPhone);

    const hubMsg =
      `🏪 *FLOATE MERCHANT DASHBOARD*\n\n` +
      `👋 *Welcome back, ${existingMerchant.businessName}!*` +
      (existingMerchant.ownerFullName ? `\n👤 *Owner:* ${existingMerchant.ownerFullName}` : '') +
      `\n📍 *Location:* ${existingMerchant.city || existingMerchant.state || 'Nigeria'}\n` +
      `🟢 *Status:* ${existingMerchant.isVerified ? '✓ Verified Active Merchant' : 'Active'}\n\n` +
      `📊 *Live Performance Overview:*\n` +
      `• 🔍 *Search Appearances:* ${stats.appearances} views\n` +
      `• 👥 *Direct Buyer Leads:* ${stats.leadsGenerated} inquiries\n` +
      `• 📦 *Active Products:* ${stats.productCount} items listed\n\n` +
      `*Merchant Management Options:*\n` +
      `1️⃣ 📊 View Performance & Stats\n` +
      `2️⃣ 📦 Add New Product / Service\n` +
      `3️⃣ ✏️ Edit Listings & Prices\n` +
      `4️⃣ 🗑️ Delete / Deactivate Account\n\n` +
      `_Tap an option below or reply with a number (1-4):_`;

    await sendWhatsAppMessage(toPhone, hubMsg, {
      listMenu: {
        buttonText: '⚙️ Manage Business',
        title: 'Merchant Self-Service',
        sections: [
          {
            title: '🏪 Merchant Options',
            rows: [
              { id: 'btn_vendor_stats', title: '📊 Performance & Stats', description: 'Search appearances and customer leads' },
              { id: 'btn_vendor_add_product', title: '📦 Add New Product', description: 'Add item, price & description' },
              { id: 'btn_vendor_edit_products', title: '✏️ Edit Listings & Prices', description: 'Update inventory, prices & items' },
              { id: 'btn_vendor_delete_account', title: '🗑️ Delete / Deactivate', description: 'Remove business from Floate search' },
            ],
          },
        ],
      },
    });
    return;
  }

  // SCENARIO B: New Unregistered Vendor
  const introMsg =
    `🏪 *Grow Your Business with FLOATE!*\n\n` +
    `List your shop to start receiving direct, qualified buyer inquiries on WhatsApp with **zero commission**.\n\n` +
    `💡 *Tip:* Save this number as *FLOATE* to easily manage your store anytime!\n\n` +
    `✨ *What you get:*\n` +
    `• 🟢 Verified Vendor badge\n` +
    `• 📈 Direct wholesale & retail buyers\n` +
    `• 📍 Market hub listing (Alaba, Onitsha, Balogun, Aba, Kano, etc.)\n\n` +
    `*Choose an option below:*`;

  await sendWhatsAppMessage(toPhone, introMsg, {
    quickReplies: [
      { id: 'btn_start_registration', title: '📝 Register Shop' },
      { id: 'btn_claim_shop', title: '🛡️ Claim Listing' },
      { id: 'btn_home', title: '🏠 Main Menu' },
    ],
  });
}

/**
 * 5a. Performance & Stats
 */
async function handleVendorStats(toPhone: string, senderName: string) {
  const merchant = await firestoreDb.getMerchant(toPhone) || sheetsDb.getListingByPhone(toPhone);
  const bizName = merchant?.businessName || 'Your Business';
  const stats = await firestoreDb.getMerchantStats(toPhone);

  const statsMsg =
    `📊 *MERCHANT PERFORMANCE & STATS*\n\n` +
    `🏬 *Business:* ${bizName}\n` +
    `🟢 *Status:* ${stats.isVerified ? '✓ Verified Active Merchant' : 'Active'}\n` +
    `📅 *Listed Since:* ${stats.registeredSince}\n\n` +
    `📈 *Key Metrics:*\n` +
    `• 🔍 *Search Appearances:* ${stats.appearances} times in FLOATE discovery\n` +
    `• 👥 *Buyer Inquiries / Leads:* ${stats.leadsGenerated} direct customer leads\n` +
    `• 📦 *Active Items in Catalog:* ${stats.productCount} products\n\n` +
    `_Your store is live and actively matched to buyers searching on WhatsApp and Web._`;

  updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL' });

  await sendWhatsAppMessage(toPhone, statsMsg, {
    quickReplies: [
      { id: 'btn_vendor_add_product', title: '📦 Add Product' },
      { id: 'btn_vendor_edit_products', title: '✏️ Edit Listings' },
      { id: 'btn_for_businesses', title: '🏪 Store Menu' },
    ],
  });
}

/**
 * 5b. Add New Product / Service Flow
 */
async function startVendorAddProduct(toPhone: string, senderName: string) {
  updateWhatsAppSession(toPhone, {
    state: 'VENDOR_ADD_PRODUCT',
    vendorAddDraft: {
      step: 'NAME',
      updatedAt: new Date().toISOString(),
    },
  });

  await sendWhatsAppMessage(
    toPhone,
    `📦 *Add New Product / Service (Step 1/3)*\n\n` +
    `What is the **name** or title of the item you want to list?\n\n` +
    `_(e.g., Italian Men Leather Shoes Size 42-45, 5kVA Solar Inverter System, or Wholesale Dubai Abaya Gowns)_\n\n` +
    `_Type *Cancel* anytime to return._`
  );
}

async function handleVendorAddProductStep(toPhone: string, senderName: string, text: string, session: any) {
  const draft = session.vendorAddDraft || { step: 'NAME', updatedAt: new Date().toISOString() };
  const cleanInput = text.trim();

  if (/^(cancel|exit|stop|menu|home)$/i.test(cleanInput)) {
    updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL', vendorAddDraft: undefined });
    await handleVendorHubRouting(toPhone, senderName);
    return;
  }

  if (draft.step === 'NAME') {
    draft.productName = cleanInput;
    draft.step = 'PRICE';
    draft.updatedAt = new Date().toISOString();
    updateWhatsAppSession(toPhone, { vendorAddDraft: draft });

    await sendWhatsAppMessage(
      toPhone,
      `💰 *Step 2/3: Set Product Price*\n\n` +
      `What is the price for *${draft.productName}*?\n\n` +
      `_(e.g., \`₦35,000\`, \`45k\`, \`₦12,500 per pair\`, or \`Negotiable\`)_`
    );
    return;
  }

  if (draft.step === 'PRICE') {
    draft.price = cleanInput;
    draft.step = 'DESC';
    draft.updatedAt = new Date().toISOString();
    updateWhatsAppSession(toPhone, { vendorAddDraft: draft });

    await sendWhatsAppMessage(
      toPhone,
      `📝 *Step 3/3: Category / Description*\n\n` +
      `Enter category or description for *${draft.productName}* (or type *Skip*):\n\n` +
      `_(e.g., \`Fashion & Footwear\`, \`Electronics\`, \`Wholesale & Retail\`)_`
    );
    return;
  }

  if (draft.step === 'DESC') {
    const descOrCat = cleanInput.toLowerCase() === 'skip' ? 'General' : cleanInput;
    draft.description = descOrCat;
    draft.category = descOrCat;

    // Fetch merchant business details
    const merchant = await firestoreDb.getMerchant(toPhone) || sheetsDb.getListingByPhone(toPhone);
    const bizName = merchant?.businessName || 'Verified Merchant';
    const state = merchant?.state || 'Lagos';
    const city = merchant?.city || 'Trade Fair';

    // Save to Firestore and Sheets
    const savedProd = await firestoreDb.saveProductListing({
      userId: merchant?.userId || toPhone,
      businessName: bizName,
      whatsapp: toPhone,
      state,
      city,
      category: draft.category || 'General',
      product: draft.productName || 'New Product',
      price: draft.price || 'Contact for Price',
      negotiation: 'Yes',
      specs: draft.description || '',
    });

    updateWhatsAppSession(toPhone, {
      state: 'VENDOR_PORTAL',
      vendorAddDraft: undefined,
    });

    const successMsg =
      `🎉 *Product Successfully Published!* 🎉\n\n` +
      `Your item is now live in FLOATE search index:\n\n` +
      `📦 *Item:* ${savedProd.product}\n` +
      `💰 *Price:* ${savedProd.price}\n` +
      `📂 *Category:* ${savedProd.category}\n` +
      `📍 *Location:* ${city}, ${state}\n` +
      `🟢 *Status:* Live & Discoverable by Buyers!\n\n` +
      `What would you like to do next?`;

    await sendWhatsAppMessage(toPhone, successMsg, {
      quickReplies: [
        { id: 'btn_vendor_add_product', title: '📦 Add Another' },
        { id: 'btn_vendor_edit_products', title: '✏️ View Inventory' },
        { id: 'btn_for_businesses', title: '🏪 Store Menu' },
      ],
    });
  }
}

/**
 * 5c. Edit Listings & Prices Flow
 */
async function startVendorEditProducts(toPhone: string, senderName: string) {
  const products = await firestoreDb.getProductsByMerchant(toPhone);
  if (!products || products.length === 0) {
    await sendWhatsAppMessage(
      toPhone,
      `📦 *No products found in your catalog yet.*\n\nTap below to add your first product listing:`,
      {
        quickReplies: [
          { id: 'btn_vendor_add_product', title: '📦 Add Product' },
          { id: 'btn_for_businesses', title: '🏪 Store Menu' },
          { id: 'btn_home', title: '🏠 Main Menu' },
        ],
      }
    );
    return;
  }

  // Display inventory items with numbers
  let listText = `📦 *YOUR STORE INVENTORY (${products.length} Items)*\n\n`;
  products.slice(0, 10).forEach((p, idx) => {
    listText += `${idx + 1}️⃣ *${p.product}*\n   💰 Price: ${p.price}\n   📂 Category: ${p.category}\n\n`;
  });

  listText += `💬 *Reply with the item number (e.g. \`1\` or \`2\`)* to update its price or remove it.`;

  updateWhatsAppSession(toPhone, {
    state: 'VENDOR_EDIT_PRODUCTS',
    vendorEditDraft: {
      step: 'SELECT',
      updatedAt: new Date().toISOString(),
    },
  });

  await sendWhatsAppMessage(toPhone, listText, {
    quickReplies: [
      { id: 'btn_vendor_add_product', title: '📦 Add New Item' },
      { id: 'btn_for_businesses', title: '🏪 Store Menu' },
      { id: 'btn_home', title: '🏠 Main Menu' },
    ],
  });
}

async function handleVendorEditProductsStep(toPhone: string, senderName: string, text: string, session: any) {
  const draft = session.vendorEditDraft || { step: 'SELECT', updatedAt: new Date().toISOString() };
  const cleanInput = text.trim();
  const cleanLower = cleanInput.toLowerCase();

  if (/^(cancel|exit|stop|menu|home|btn_home)$/i.test(cleanLower)) {
    updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL', vendorEditDraft: undefined });
    await handleVendorHubRouting(toPhone, senderName);
    return;
  }

  const products = await firestoreDb.getProductsByMerchant(toPhone);

  if (draft.step === 'SELECT') {
    const num = parseInt(cleanInput, 10);
    if (isNaN(num) || num < 1 || num > products.length) {
      await sendWhatsAppMessage(toPhone, `⚠️ Please reply with a valid item number (1 - ${products.length}), or type *Cancel*.`);
      return;
    }

    const selected = products[num - 1];
    draft.selectedProductId = selected.id;
    draft.selectedProductName = selected.product;
    draft.step = 'ACTION';
    draft.updatedAt = new Date().toISOString();
    updateWhatsAppSession(toPhone, { vendorEditDraft: draft });

    const manageMsg =
      `✏️ *Managing Item: ${selected.product}*\n\n` +
      `• 💰 *Current Price:* ${selected.price}\n` +
      `• 📂 *Category:* ${selected.category}\n\n` +
      `*What would you like to update?*`;

    await sendWhatsAppMessage(toPhone, manageMsg, {
      quickReplies: [
        { id: 'btn_edit_price', title: '💰 Update Price' },
        { id: 'btn_delete_item', title: '🗑️ Delete Item' },
        { id: 'btn_vendor_edit_products', title: '↩️ Back to List' },
      ],
    });
    return;
  }

  if (draft.step === 'ACTION') {
    if (text === 'btn_edit_price' || /^(price|update price|edit price|1)$/i.test(cleanLower)) {
      draft.action = 'PRICE';
      draft.step = 'VALUE';
      draft.updatedAt = new Date().toISOString();
      updateWhatsAppSession(toPhone, { vendorEditDraft: draft });

      await sendWhatsAppMessage(
        toPhone,
        `💰 *Enter New Price for "${draft.selectedProductName}":*\n\n_(e.g. \`₦40,000\`, \`25k\`, or \`Negotiable\`)_`
      );
      return;
    }

    if (text === 'btn_delete_item' || /^(delete|remove|delete item|2)$/i.test(cleanLower)) {
      if (draft.selectedProductId) {
        await firestoreDb.deleteProductById(draft.selectedProductId);
      }
      updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL', vendorEditDraft: undefined });

      await sendWhatsAppMessage(
        toPhone,
        `🗑️ *Item Deleted.*\n*"${draft.selectedProductName}"* has been removed from your store catalog.`,
        {
          quickReplies: [
            { id: 'btn_vendor_edit_products', title: '✏️ View Listings' },
            { id: 'btn_vendor_add_product', title: '📦 Add Item' },
            { id: 'btn_for_businesses', title: '🏪 Store Menu' },
          ],
        }
      );
      return;
    }

    if (text === 'btn_vendor_edit_products' || cleanLower === 'back') {
      await startVendorEditProducts(toPhone, senderName);
      return;
    }
  }

  if (draft.step === 'VALUE' && draft.action === 'PRICE') {
    if (draft.selectedProductId) {
      await firestoreDb.updateProduct(draft.selectedProductId, { price: cleanInput });
    }

    updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL', vendorEditDraft: undefined });

    await sendWhatsAppMessage(
      toPhone,
      `✅ *Price Updated Successfully!*\n\n` +
      `📦 *Item:* ${draft.selectedProductName}\n` +
      `💰 *New Price:* ${cleanInput}\n\n` +
      `Your updated price is now live on FLOATE!`,
      {
        quickReplies: [
          { id: 'btn_vendor_edit_products', title: '✏️ View Inventory' },
          { id: 'btn_vendor_add_product', title: '📦 Add Item' },
          { id: 'btn_for_businesses', title: '🏪 Store Menu' },
        ],
      }
    );
  }
}

/**
 * 5d. Delete Store Account Flow
 */
async function startVendorDeleteAccount(toPhone: string, senderName: string) {
  const merchant = await firestoreDb.getMerchant(toPhone) || sheetsDb.getListingByPhone(toPhone);
  const bizName = merchant?.businessName || 'Your Store';
  const products = await firestoreDb.getProductsByMerchant(toPhone);

  updateWhatsAppSession(toPhone, { state: 'VENDOR_DELETE_CONFIRM' });

  const warnMsg =
    `⚠️ *DANGER ZONE: Delete & Deactivate Store*\n\n` +
    `Are you sure you want to remove *${bizName}* from FLOATE?\n\n` +
    `• Your business profile will be deleted.\n` +
    `• All *${products.length} product listings* will be removed from search.\n` +
    `• You will stop receiving buyer inquiries.\n\n` +
    `*This action cannot be undone.*`;

  await sendWhatsAppMessage(toPhone, warnMsg, {
    quickReplies: [
      { id: 'btn_confirm_delete_account', title: '🗑️ Yes, Delete Store' },
      { id: 'btn_for_businesses', title: '❌ Cancel, Keep Store' },
      { id: 'btn_home', title: '🏠 Main Menu' },
    ],
  });
}

async function handleVendorDeleteAccountConfirm(toPhone: string, senderName: string, text: string) {
  if (text === 'btn_confirm_delete_account' || /^(yes|confirm|delete my store|yes delete)$/i.test(text.trim())) {
    await firestoreDb.deleteMerchant(toPhone);
    resetWhatsAppSession(toPhone);

    await sendWhatsAppMessage(
      toPhone,
      `✅ *Store Account Deleted.*\n\n` +
      `Your business profile and listings have been removed from the FLOATE directory.\n\n` +
      `You can re-register anytime whenever you are ready!`,
      {
        quickReplies: [
          { id: 'btn_start_registration', title: '📝 Register New Shop' },
          { id: 'btn_find_product', title: '🔍 Search Items' },
          { id: 'btn_home', title: '🏠 Main Menu' },
        ],
      }
    );
    return;
  }

  // Cancelled
  updateWhatsAppSession(toPhone, { state: 'VENDOR_PORTAL' });
  await handleVendorHubRouting(toPhone, senderName);
}

/**
 * 6. CONVERSATIONAL 6-STEP VENDOR REGISTRATION
 */
async function startConversationalRegistration(toPhone: string, senderName: string) {
  updateWhatsAppSession(toPhone, {
    state: 'REG_ONBOARDING',
    regDraft: {
      step: 'STEP_1_NAME',
      updatedAt: new Date().toISOString(),
    },
  });

  await sendWhatsAppMessage(
    toPhone,
    `👤 *Step 1 of 6: Owner Full Name*\n\n` +
    `What is your **Full Legal Name**?\n` +
    `_(e.g., Emeka Chukwuma Okafor)_`
  );
}

async function handleRegistrationSteps(
  toPhone: string,
  senderName: string,
  text: string,
  imageId: string | null | undefined,
  imageMimeType: string | undefined,
  session: any
) {
  const draft = session.regDraft || { step: 'STEP_1_NAME' };

  // Step 1 -> Step 2: Owner Full Name
  if (draft.step === 'STEP_1_NAME') {
    if (text.length < 3) {
      await sendWhatsAppMessage(toPhone, `⚠️ Please provide your full First & Last Name to proceed.`);
      return;
    }
    updateWhatsAppSession(toPhone, {
      regDraft: {
        ...draft,
        ownerFullName: text,
        step: 'STEP_2_BIZ',
        updatedAt: new Date().toISOString(),
      },
    });

    await sendWhatsAppMessage(
      toPhone,
      `🏪 *Step 2 of 6: Business Details & CAC*\n\n` +
      `What is your **Business or Shop Name**?\n\n` +
      `_(Optional: If registered with CAC, you can include your RC or BN number, e.g. "Divine Footwear Collection (RC: 1234567)" or "Divine Footwear")_`
    );
    return;
  }

  // Step 2 -> Step 3: Business Name & CAC
  if (draft.step === 'STEP_2_BIZ') {
    if (text.length < 2) {
      await sendWhatsAppMessage(toPhone, `⚠️ Please provide your Business or Shop name.`);
      return;
    }

    // Extract optional CAC if present in text
    let cacNumber = '';
    const cacMatch = text.match(/(?:RC|BN|CAC|REG)[:\s-]*([0-9]{5,10})/i);
    if (cacMatch) {
      cacNumber = cacMatch[1];
    }

    updateWhatsAppSession(toPhone, {
      regDraft: {
        ...draft,
        businessName: text.replace(/\(?(?:RC|BN|CAC)[:\s-]*[0-9]+\)?/gi, '').trim(),
        cacNumber: cacNumber || undefined,
        step: 'STEP_3_LOCATION',
        updatedAt: new Date().toISOString(),
      },
    });

    await sendWhatsAppMessage(
      toPhone,
      `📍 *Step 3 of 6: Market Hub & Shop Address*\n\n` +
      `Where is your shop physically located?\n\n` +
      `_(e.g., Shop 24, Block C, Line 4, Main Market, Onitsha)_`
    );
    return;
  }

  // Step 3 -> Step 4: Shop Location
  if (draft.step === 'STEP_3_LOCATION') {
    if (text.length < 4) {
      await sendWhatsAppMessage(toPhone, `⚠️ Please provide your market location and shop number/line.`);
      return;
    }
    updateWhatsAppSession(toPhone, {
      regDraft: {
        ...draft,
        shopAddress: text,
        step: 'STEP_4_PRODUCTS',
        updatedAt: new Date().toISOString(),
      },
    });

    await sendWhatsAppMessage(
      toPhone,
      `🏷️ *Step 4 of 6: Products in Stock & Prices*\n\n` +
      `What key items do you sell and what is your typical price range?\n\n` +
      `_(e.g., Italian leather slippers, Chelsea boots, formal shoes from ₦15,000 to ₦35,000)_`
    );
    return;
  }

  // Step 4 -> Step 5: Products & Price Range
  if (draft.step === 'STEP_4_PRODUCTS') {
    if (text.length < 3) {
      await sendWhatsAppMessage(toPhone, `⚠️ Please describe what items you sell.`);
      return;
    }
    updateWhatsAppSession(toPhone, {
      regDraft: {
        ...draft,
        productsDescription: text,
        step: 'STEP_5_PHOTO',
        updatedAt: new Date().toISOString(),
      },
    });

    await sendWhatsAppMessage(
      toPhone,
      `📸 *Step 5 of 6: Live Identity Verification*\n\n` +
      `Please take and send a **clear selfie of your face** (or passport photo) right here on WhatsApp.\n\n` +
      `💡 *Photo Guidelines:*\n` +
      `• Well-lit photo showing your face clearly.\n` +
      `• Single person only (no group pictures).\n` +
      `• Real human photo (no avatars, cartoons, sunglasses, or AI-generated images).`
    );
    return;
  }

  // Step 5 -> Step 6: AI Selfie Verification with Gemini Vision
  if (draft.step === 'STEP_5_PHOTO') {
    if (!imageId) {
      await sendWhatsAppMessage(
        toPhone,
        `📸 *Please attach and send a photo* from your phone camera to complete identity verification.`
      );
      return;
    }

    await sendWhatsAppMessage(toPhone, `🔄 *Analyzing verification photo with AI...* Please wait a moment.`);

    const media = await downloadWhatsAppMedia(imageId);
    if (!media) {
      await sendWhatsAppMessage(toPhone, `⚠️ Could not download photo. Please try uploading the selfie again.`);
      return;
    }

    const validation = await validateSelfieWithGeminiVision(media.buffer, imageMimeType || media.mimeType);

    if (!validation.isValid) {
      await sendWhatsAppMessage(
        toPhone,
        `⚠️ *Photo Verification Issue:*\n\n${validation.userGuidance || 'The photo could not be verified as a clear human selfie.'}\n\n📸 *Please take a new, well-lit photo showing your face clearly.*`
      );
      return;
    }

    updateWhatsAppSession(toPhone, {
      regDraft: {
        ...draft,
        photoVerified: true,
        photoMediaId: imageId,
        step: 'STEP_6_CONFIRM',
        updatedAt: new Date().toISOString(),
      },
    });

    // Send Step 6 Confirmation Summary Card
    const summaryCard =
      `📋 *Please Confirm Your Business Listing:*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Owner:* ${draft.ownerFullName}\n` +
      `🏬 *Business:* ${draft.businessName}\n` +
      `🏛️ *CAC Status:* ${draft.cacNumber ? `Registered (RC: ${draft.cacNumber})` : 'Sole Trader'}\n` +
      `📍 *Location:* ${draft.shopAddress}\n` +
      `📦 *Products:* ${draft.productsDescription}\n` +
      `📸 *Face Verification:* ✅ Approved by Gemini Vision\n` +
      `📱 *WhatsApp Contact:* +${toPhone}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `By confirming, you agree to FLOATE's Terms of Service and Vendor Standards.`;

    await sendWhatsAppMessage(toPhone, summaryCard, {
      quickReplies: [
        { id: 'btn_confirm_registration', title: '✅ Confirm & Go Live' },
        { id: 'btn_start_registration', title: '✏️ Edit Info' },
        { id: 'btn_home', title: '❌ Cancel' },
      ],
    });
    return;
  }

  // Step 6: Confirmation Action
  if (draft.step === 'STEP_6_CONFIRM') {
    const isConfirmed = text === 'btn_confirm_registration' || /confirm|yes|agree|live/i.test(text);
    if (isConfirmed) {
      const bizName = draft.businessName || 'Verified Vendor';
      const prodDesc = draft.productsDescription || '';
      const category = draft.category || 'General Commerce';

      // 1. Run Gemini Anti-Fraud & Safety Gate Check
      const { auditBusinessRegistrationWithGemini } = await import('./registrationSafetyService.js');
      const safetyAudit = await auditBusinessRegistrationWithGemini({
        businessName: bizName,
        category,
        productDescription: prodDesc,
      });

      console.log(`[Safety Gate WA] +${toPhone} (${bizName}): Decision=${safetyAudit.decision} (Reason: ${safetyAudit.reason})`);

      // TIER 1: HARD BLOCK (Immediate rejection, no admin notification)
      if (safetyAudit.decision === 'HARD_BLOCK') {
        resetWhatsAppSession(toPhone);
        console.warn(`[SAFETY HARD BLOCK WA] Auto-rejected +${toPhone} (${bizName}): ${safetyAudit.reason}`);

        await sendWhatsAppMessage(
          toPhone,
          `❌ *Registration Notice*\n\nThis registration cannot be approved as it falls outside Floate's permitted business categories.`
        );
        return;
      }

      // TIER 2: MANUAL REVIEW REQUIRED (Regulated / Age-restricted goods -> PENDING_REVIEW)
      if (safetyAudit.decision === 'PENDING_REVIEW') {
        const pendingDoc = await firestoreDb.savePendingReviewMerchant({
          id: toPhone,
          userId: toPhone,
          businessName: bizName,
          ownerFullName: draft.ownerFullName,
          whatsapp: toPhone,
          state: draft.shopAddress || 'Nigeria',
          city: draft.shopAddress || 'Nigeria',
          listingType: 'Product',
          category,
          product: prodDesc,
          price: draft.priceRange || 'Market Rate',
          negotiation: 'Yes',
          status: 'PENDING_REVIEW',
          safetyReason: safetyAudit.reason,
          safetyFlags: safetyAudit.categoryFlags,
        });

        const { alertAdminPendingReviewRegistration } = await import('./whatsappAdminService.js');
        await alertAdminPendingReviewRegistration({
          merchantId: pendingDoc.id,
          businessName: bizName,
          phone: toPhone,
          category,
          product: prodDesc,
          price: draft.priceRange || 'Market Rate',
          location: draft.shopAddress,
          ownerFullName: draft.ownerFullName,
          reason: safetyAudit.reason,
          flags: safetyAudit.categoryFlags,
        });

        resetWhatsAppSession(toPhone);

        await sendWhatsAppMessage(
          toPhone,
          `Thanks for registering! Your business is under review and you'll be notified once approved, usually within 24 hours.`
        );
        return;
      }

      // TIER 3: AUTO_APPROVE (Standard Commerce)
      try {
        await sheetsDb.registerBusiness({
          userId: toPhone,
          businessName: bizName,
          ownerFullName: draft.ownerFullName,
          whatsapp: toPhone,
          product: prodDesc,
          city: draft.shopAddress || 'Nigeria',
          state: draft.shopAddress || 'Nigeria',
          category,
          price: draft.priceRange || 'Market Rate',
          listingType: 'Product',
        });
      } catch (err) {
        console.warn('[Reg Sync Error]:', err);
      }

      // Alert Admin on WhatsApp of regular new registration
      await alertAdminNewVendorRegistration({
        ownerFullName: draft.ownerFullName || '',
        businessName: bizName,
        cacNumber: draft.cacNumber,
        location: draft.shopAddress || '',
        products: prodDesc,
        priceRange: draft.priceRange || 'Standard Market Rates',
        phone: toPhone,
      });

      resetWhatsAppSession(toPhone);

      await sendWhatsAppMessage(
        toPhone,
        `🎉 *Congratulations, ${bizName}! Your business is now LIVE on FLOATE!*\n\n` +
        `🟢 *Status:* Verified Vendor\n` +
        `📲 Buyers searching for your products in ${draft.shopAddress} will now be connected directly to your WhatsApp!\n\n` +
        `Welcome to the FLOATE Merchant Network. 🚀`,
        {
          quickReplies: [
            { id: 'btn_find_product', title: '🔍 Test Search' },
            { id: 'btn_for_businesses', title: '🏪 Vendor Hub' },
            { id: 'btn_home', title: '🏠 Main Menu' },
          ],
        }
      );
    }
  }
}

/**
 * 7. CLAIM EXISTING BUSINESS FLOW VIA WHATSAPP OTP
 */
async function startClaimBusinessFlow(toPhone: string, senderName: string) {
  updateWhatsAppSession(toPhone, {
    state: 'CLAIM_PROCESS',
    claimDraft: {
      step: 'AWAITING_BIZ_NAME',
      updatedAt: new Date().toISOString(),
    },
  });

  await sendWhatsAppMessage(
    toPhone,
    `🛡️ *Claim Your Existing Business Listing*\n\n` +
    `What is your **Business Name or Registered Phone Number** in our directory?\n` +
    `_(e.g. Divine Footwear or 08012345678)_`
  );
}

async function handleClaimProcessSteps(toPhone: string, senderName: string, text: string, session: any) {
  const draft = session.claimDraft || { step: 'AWAITING_BIZ_NAME' };

  if (draft.step === 'AWAITING_BIZ_NAME') {
    const searchMatch = sheetsDb.getListingBySlugOrName(text);
    if (!searchMatch) {
      await sendWhatsAppMessage(
        toPhone,
        `⚠️ Could not find a listing matching "${text}".\n\nPlease check the spelling or tap below to register a new listing:`,
        {
          quickReplies: [
            { id: 'btn_start_registration', title: '📝 Register New' },
            { id: 'btn_home', title: '🏠 Main Menu' },
          ],
        }
      );
      return;
    }

    const regPhone = normalizePhone(searchMatch.whatsapp);
    const senderClean = normalizePhone(toPhone);

    // If sender's phone matches the listed phone -> Instant Auto-Claim!
    if (regPhone && (regPhone === senderClean || regPhone === `0${senderClean.slice(3)}`)) {
      sheetsDb.updateListing(searchMatch.id, {
        isVerified: true,
        verifiedStatus: 'YES',
      });
      await firestoreDb.syncMerchantsFromListings([searchMatch]);

      resetWhatsAppSession(toPhone);
      await sendWhatsAppMessage(
        toPhone,
        `🎉 *Instant Verification Successful!*\n\n` +
        `Your WhatsApp number matches the directory listing for *${searchMatch.businessName}*.\n` +
        `Your listing is now officially claimed and verified! 🟢`,
        {
          quickReplies: [
            { id: 'btn_for_businesses', title: '🏪 Vendor Hub' },
            { id: 'btn_home', title: '🏠 Main Menu' },
          ],
        }
      );
      return;
    }

    // Different phone -> Generate and send 4-digit OTP to the registered phone
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpires = Date.now() + 5 * 60 * 1000;

    updateWhatsAppSession(toPhone, {
      claimDraft: {
        step: 'AWAITING_OTP',
        listingId: searchMatch.id,
        businessName: searchMatch.businessName,
        registeredPhone: searchMatch.whatsapp,
        otpCode,
        otpExpiresAt: otpExpires,
        updatedAt: new Date().toISOString(),
      },
    });

    // Dispatch OTP to the registered business phone
    const intlPhone = regPhone.replace(/^0/, '234');
    await sendWhatsAppMessage(
      intlPhone,
      `🔐 *FLOATE Security Code:*\nYour verification code to claim ownership of *${searchMatch.businessName}* is *${otpCode}*.\nExpires in 5 minutes. Do not share with anyone.`
    ).catch(() => {});

    await sendWhatsAppMessage(
      toPhone,
      `📨 *Verification Code Sent*\n\n` +
      `We sent a 4-digit verification code to the registered phone on file (*${regPhone.slice(0, 4)}****${regPhone.slice(-3)}*).\n\n` +
      `Please enter the 4-digit code here to complete the claim:`
    );
    return;
  }

  if (draft.step === 'AWAITING_OTP') {
    const entered = text.replace(/\D/g, '');
    if (Date.now() > (draft.otpExpiresAt || 0)) {
      resetWhatsAppSession(toPhone);
      await sendWhatsAppMessage(toPhone, `⏱️ *Verification code expired.* Please start the claim process again.`);
      return;
    }

    if (entered !== draft.otpCode) {
      await sendWhatsAppMessage(toPhone, `❌ *Invalid code.* Please check and enter the 4-digit code sent via WhatsApp.`);
      return;
    }

    // Success -> Transfer listing ownership
    if (draft.listingId) {
      const updated = sheetsDb.updateListing(draft.listingId, {
        whatsapp: toPhone,
        isVerified: true,
        verifiedStatus: 'YES',
      });
      if (updated) {
        await firestoreDb.syncMerchantsFromListings([updated]);
      }
    }

    resetWhatsAppSession(toPhone);
    await sendWhatsAppMessage(
      toPhone,
      `🎉 *Ownership Verified!* You have successfully claimed *${draft.businessName}* on FLOATE! 🟢`,
      {
        quickReplies: [
          { id: 'btn_for_businesses', title: '🏪 Vendor Hub' },
          { id: 'btn_home', title: '🏠 Main Menu' },
        ],
      }
    );
  }
}
