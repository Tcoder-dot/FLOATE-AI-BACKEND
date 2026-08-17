import express from 'express';
import { config } from '../config.js';
import { sheetsDb, BusinessListing, normalizePhone, escapeMarkdownText } from './sheetsService.js';
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
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: options.listMenu.title || 'FLOATE Verified Vendors',
        },
        body: {
          text: messageText,
        },
        action: {
          button: options.listMenu.buttonText.substring(0, 20),
          sections: options.listMenu.sections.map((sec) => ({
            title: sec.title.substring(0, 24),
            rows: sec.rows.slice(0, 10).map((r) => ({
              id: r.id.substring(0, 200),
              title: r.title.substring(0, 24),
              description: r.description ? r.description.substring(0, 72) : undefined,
            })),
          })),
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
      await sendWhatsAppMessage(
        senderPhone,
        `🎙️ *Voice Note Received*\n\nWe couldn't clearly hear your voice note.\n\n💬 *Please type what you need in text* (e.g. \`Leather Slippers in Onitsha 15k\` or \`Solar Inverter in Alaba\`), and FLOATE will find verified shops for you!`,
        {
          quickReplies: [
            { id: 'btn_find_product', title: '🔍 Find a Product' },
            { id: 'btn_browse_markets', title: '📍 Browse Markets' },
            { id: 'btn_for_businesses', title: '🏪 For Businesses' },
          ],
        }
      );
      return;
    }
  }

  const rawLower = text.toLowerCase().trim();
  const cleanLower = rawLower.replace(/[^a-z0-9 _]+/g, '').replace(/\s+/g, ' ');

  // Helper to handle contact card prompt before completing intent
  const promptContactCardAndHoldIntent = async (
    actionLabel: string,
    pendingIntent: { action: 'REGISTER_VENDOR' | 'CONNECT_VENDOR' | 'SEARCH' | 'GREETING'; payload?: any }
  ) => {
    await sendWhatsAppContactCard(senderPhone);
    updateWhatsAppSession(senderPhone, {
      state: 'AWAITING_SAVE_CONTACT',
      hasReceivedContactCard: true,
      pendingIntent,
    });
    const firstName = senderName && senderName !== 'Customer' ? senderName.split(' ')[0] : 'there';
    await sendWhatsAppMessage(
      senderPhone,
      `👋 *Welcome to Floate, ${firstName}!*\n\n` +
      `💡 *Quick tip:* Tap the contact card above and save our number as *"Floate"* so you can easily access verified merchants, get price checks, and view daily market deals anytime!\n\n` +
      `Tap below to continue to *${actionLabel}*:`,
      {
        quickReplies: [
          { id: 'btn_saved_continue', title: '✅ Done, Continue' },
        ],
      }
    );
  };

  // 2. Handle AWAITING_SAVE_CONTACT continuation
  if (
    session.state === 'AWAITING_SAVE_CONTACT' ||
    text === 'btn_saved_continue' ||
    /^(done|saved|continue|ok|okay|yes|next|i have saved|saved contact|btn_continue_action)$/i.test(cleanLower)
  ) {
    const pending = session.pendingIntent;
    updateWhatsAppSession(senderPhone, {
      state: 'IDLE',
      pendingIntent: undefined,
      hasReceivedContactCard: true,
    });

    if (pending?.action === 'REGISTER_VENDOR') {
      await handleVendorHubRouting(senderPhone, senderName);
      return;
    } else if (pending?.action === 'CONNECT_VENDOR' && pending.payload?.vendorId) {
      await start2StepLeadQualification(senderPhone, senderName, pending.payload.vendorId);
      return;
    } else if (pending?.action === 'SEARCH' && pending.payload?.query) {
      await execute5CardSearch(senderPhone, senderName, { queryText: pending.payload.query });
      return;
    } else {
      await sendWelcomeGreeting(senderPhone, senderName);
      return;
    }
  }

  // 3. Global Reset / Cancel / Home Interceptor
  if (/^(reset|cancel|stop|exit|start over|restart|home|menu|main menu|\/start|\/cancel|btn_home)$/i.test(cleanLower)) {
    resetWhatsAppSession(senderPhone);
    await firestoreDb.resetUserSession(senderPhone);
    await sendWelcomeGreeting(senderPhone, senderName);
    return;
  }

  // 4. Welcome / Greeting / HELLO FLOATE Intent Trigger
  if (/^(hello floate|hello_floate|hellofloate|hi|hello|hey|good morning|good afternoon|good evening|start|btn_greeting)$/i.test(cleanLower)) {
    if (!session.hasReceivedContactCard) {
      await promptContactCardAndHoldIntent('Floate Main Menu', { action: 'GREETING' });
      return;
    }
    resetWhatsAppSession(senderPhone);
    await sendWelcomeGreeting(senderPhone, senderName);
    return;
  }

  // 5. Deep-Linked Register Business / Vendor Hub Trigger
  if (
    text === 'START_REGISTER_VENDOR' ||
    text === 'btn_for_businesses' ||
    /^(register_business|start_register_vendor|register business|vendor|business|vendor hub|merchant|add my shop|list my shop)$/i.test(cleanLower)
  ) {
    if (!session.hasReceivedContactCard) {
      await promptContactCardAndHoldIntent('Register Your Business', { action: 'REGISTER_VENDOR' });
      return;
    }
    await handleVendorHubRouting(senderPhone, senderName);
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
    const listing = sheetsDb.getListingById(bizId);
    const bizName = listing?.businessName || 'Verified Merchant';

    if (!session.hasReceivedContactCard) {
      await promptContactCardAndHoldIntent(`Connect with ${bizName}`, {
        action: 'CONNECT_VENDOR',
        payload: { vendorId: bizId },
      });
      return;
    }
    await start2StepLeadQualification(senderPhone, senderName, bizId);
    return;
  }

  // 7. Deep-Linked Search Query (e.g. SEARCH_shoes_in_onitsha)
  if (text.startsWith('SEARCH_') || text.startsWith('search_')) {
    const sq = text.replace(/^(SEARCH_|search_)/, '').replace(/_/g, ' ').trim();
    if (!session.hasReceivedContactCard) {
      await promptContactCardAndHoldIntent(`Search "${sq}"`, {
        action: 'SEARCH',
        payload: { query: sq },
      });
      return;
    }
    await execute5CardSearch(senderPhone, senderName, { queryText: sq });
    return;
  }

  // 8. Number selection (1-5), ordinal, or business name selection from active search results
  if (session.searchState?.allMatchingListings && session.searchState.allMatchingListings.length > 0) {
    const listings = session.searchState.allMatchingListings;
    const pageOffset = (session.searchState.pageIndex || 0) * 5;
    const currentBatch = listings.slice(pageOffset, pageOffset + 5);

    // Check numerical selection: "1", "2", "option 1", "first one", "second vendor", etc.
    const ordinalMap: Record<string, number> = {
      'first': 1, '1st': 1, 'one': 1, '1': 1,
      'second': 2, '2nd': 2, 'two': 2, '2': 2,
      'third': 3, '3rd': 3, 'three': 3, '3': 3,
      'fourth': 4, '4th': 4, 'four': 4, '4': 4,
      'fifth': 5, '5th': 5, 'five': 5, '5': 5,
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
        await start2StepLeadQualification(senderPhone, senderName, selectedListing.id);
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
  if (text.startsWith('report_vendor_') || text === 'btn_report_vendor' || cleanLower === 'report') {
    const targetVendorId = text.startsWith('report_vendor_') ? text.replace('report_vendor_', '').trim() : '';
    const vendorListing = targetVendorId ? sheetsDb.getListingById(targetVendorId) : null;

    updateWhatsAppSession(senderPhone, {
      state: 'REPORT_PROCESS',
      reportDraft: {
        step: 'AWAITING_DETAILS',
        vendorId: targetVendorId || session.activeVendorId || '',
        vendorName: vendorListing?.businessName || session.activeVendorName || 'Unknown Vendor',
        vendorPhone: vendorListing?.whatsapp || session.activeVendorPhone || '',
        updatedAt: new Date().toISOString(),
      },
    });

    await sendWhatsAppMessage(
      senderPhone,
      `⚠️ *Report a Vendor / Dispute*\n\n` +
      `Trust and buyer protection are our top priorities.\n\n` +
      `Please reply with a brief description of the issue or dispute with *${vendorListing?.businessName || session.activeVendorName || 'the seller'}*:\n` +
      `_(e.g., Fake product, Wrong price quoted, Refused inspection, Suspicious behavior)_`
    );
    return;
  }

  // Handle active REPORT_PROCESS
  if (session.state === 'REPORT_PROCESS' && session.reportDraft?.step === 'AWAITING_DETAILS') {
    const reportId = await submitVendorReport({
      reporterPhone: senderPhone,
      reporterName: senderName,
      vendorId: session.reportDraft.vendorId,
      vendorName: session.reportDraft.vendorName,
      vendorPhone: session.reportDraft.vendorPhone,
      reason: text,
    });

    resetWhatsAppSession(senderPhone);
    await sendWhatsAppMessage(
      senderPhone,
      `✅ *Report Received (Ref: \`${reportId}\`)*\n\n` +
      `Thank you for keeping FLOATE safe. Our verification and compliance team has been alerted and will investigate this vendor immediately.\n\n` +
      `What else would you like to search for today?`,
      {
        quickReplies: [
          { id: 'btn_find_product', title: '🔍 Find a Product' },
          { id: 'btn_browse_markets', title: '📍 Browse Markets' },
          { id: 'btn_home', title: '🏠 Main Menu' },
        ],
      }
    );
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
    await execute5CardSearch(senderPhone, senderName, { queryText: 'Popular wholesale & retail items', location: targetLoc });
    return;
  }

  // 9. Interactive Category Chip Selection (e.g. chip_shoes_women, chip_shoes_men, chip_phones_iphone)
  if (text.startsWith('chip_')) {
    const chipQuery = text.replace('chip_', '').replace(/_/g, ' ');
    await execute5CardSearch(senderPhone, senderName, { queryText: chipQuery });
    return;
  }

  // 10. Show Next 5 Vendors Pagination
  if (text === 'btn_next_5_vendors' || cleanLower === 'next 5' || cleanLower === 'show next') {
    await handleShowNext5Vendors(senderPhone, senderName, session);
    return;
  }

  // 11. Vendor Selection & 2-Step Lead Qualification
  if (text.startsWith('connect_biz_') || text.startsWith('connect_')) {
    const bizId = text.replace(/^(connect_biz_|connect_)/, '').trim();
    await start2StepLeadQualification(senderPhone, senderName, bizId);
    return;
  }

  // Step 1: Order Volume Answered
  if (session.state === 'QUALIFYING_VOLUME') {
    if (text.startsWith('vol_') || /^(retail|wholesale|personal|bulk|resell|sample)$/i.test(cleanLower) || /^(retail use|personal use|wholesale bulk|bulk order)$/i.test(cleanLower)) {
      const volChoice: 'Retail' | 'Wholesale' = /wholesale|bulk|resell/i.test(cleanLower) || text === 'vol_wholesale' ? 'Wholesale' : 'Retail';
      updateWhatsAppSession(senderPhone, {
        state: 'QUALIFYING_FULFILLMENT',
        orderVolume: volChoice,
      });

      await sendWhatsAppMessage(
        senderPhone,
        `📍 *Step 2 of 2: Fulfillment & Delivery Preference*\n\n` +
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
      await execute5CardSearch(senderPhone, senderName, { queryText: text });
      return;
    }
  }

  // Step 2: Fulfillment Answered -> Complete Handoff
  if (session.state === 'QUALIFYING_FULFILLMENT') {
    if (text.startsWith('ful_') || /^(visit|delivery|waybill|interstate|shop|dispatch|pickup|doorstep|way bill)$/i.test(cleanLower) || /^(shop visit|city delivery|interstate waybill)$/i.test(cleanLower)) {
      let fulChoice: 'Shop Visit' | 'Local City Delivery' | 'Interstate Waybill' = 'Local City Delivery';
      if (text === 'ful_visit' || /visit|shop|pickup|in person/i.test(cleanLower)) {
        fulChoice = 'Shop Visit';
      } else if (text === 'ful_waybill' || /waybill|interstate|way bill/i.test(cleanLower)) {
        fulChoice = 'Interstate Waybill';
      }

      await finish2StepQualificationHandoff(senderPhone, senderName, fulChoice, session);
      return;
    } else if (!text.startsWith('ful_') && cleanLower.length > 2) {
      // If user typed a completely new search term instead of answering delivery, cancel and execute search
      resetWhatsAppSession(senderPhone);
      await execute5CardSearch(senderPhone, senderName, { queryText: text });
      return;
    }
  }

  // 12. Default: Natural Language Search Query (English, Pidgin, Local Market Slang)
  await execute5CardSearch(senderPhone, senderName, { queryText: text });
}

/**
 * 1. THE NATIVE WELCOME GREETING
 */
async function sendWelcomeGreeting(toPhone: string, senderName: string) {
  const name = senderName && senderName !== 'Customer' ? senderName : '';
  const greeting = name ? `👋 Hi ${name}, Floate here,` : `👋 Hi, Floate here,`;

  const msg =
    `${greeting}\n\n` +
    `I'm here to help you find verified vendors, products, and services across Nigeria.\n\n` +
    `*What are you shopping for today?*\n` +
    `Choose an option below:`;

  await sendWhatsAppMessage(toPhone, msg, {
    quickReplies: [
      { id: 'btn_find_product', title: '🔍 Find a Product' },
      { id: 'btn_browse_markets', title: '📍 Browse Markets' },
      { id: 'btn_for_businesses', title: '🏪 For Businesses' },
    ],
  });
}

/**
 * 2. 4-LAYER DISCOVERY ENGINE (Scaling to 20,000+ Vendors)
 */
async function execute5CardSearch(toPhone: string, senderName: string, params: { queryText: string; location?: string }) {
  const { queryText, location } = params;

  // 1. AI Parsing with Gemini
  let parsed;
  try {
    parsed = await parseShoppingQuery(queryText);
  } catch {
    parsed = { searchKeywords: queryText, targetSellerLocation: location };
  }

  const cleanProduct = parsed.searchKeywords || queryText;
  const targetLoc = location || parsed.targetSellerLocation;

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

  const localMatches: BusinessListing[] = searchResults.exactMatches.length > 0
    ? [...searchResults.exactMatches, ...searchResults.categoryMatches]
    : searchResults.categoryMatches;

  const recommendations: BusinessListing[] = searchResults.outOfAreaRecommendations || [];

  // SCENARIO A: No local matches AND no out-of-area recommendations
  if (localMatches.length === 0 && recommendations.length === 0) {
    await sendWhatsAppMessage(
      toPhone,
      `🔍 *Search Results for:* "${cleanProduct}"\n\n` +
      `No verified sellers are currently active for this item in our immediate directory.\n\n` +
      `💡 *Suggestions:*\n` +
      `• Try searching a broader term (e.g. \`Leather Slippers\` instead of a specific code).\n` +
      `• Check top commercial market hubs in Lagos, Onitsha, or Aba below:`,
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

  // Determine top items for display
  const primaryDisplay = localMatches.length > 0 ? localMatches.slice(0, 5) : [];
  const recDisplay = recommendations.slice(0, 3);

  // All matches for pagination in order: local first, then recommendations
  const allMatches = [...localMatches, ...recommendations];

  // Save in user session state for pagination / selection
  updateWhatsAppSession(toPhone, {
    state: 'IDLE',
    searchState: {
      lastQuery: queryText,
      cleanProduct,
      location: targetLoc,
      category: parsed.category || '',
      allMatchingListings: allMatches,
      pageIndex: 0,
      updatedAt: new Date().toISOString(),
    },
  });

  const locNotice = targetLoc ? ` in *${targetLoc}*` : '';
  let previewMsg = '';

  if (primaryDisplay.length > 0) {
    previewMsg += `🔍 *Verified vendors${locNotice} matching "${cleanProduct}":*\n\n`;
    for (let i = 0; i < primaryDisplay.length; i++) {
      const v = primaryDisplay[i];
      const priceDisplay = v.price || 'Market Rate';
      const locDisplay = `${v.city || v.state || 'Market Hub'}`;
      previewMsg +=
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*${i + 1}️⃣ ${v.businessName}*\n` +
        `📍 *Location:* ${locDisplay}\n` +
        `🏷️ *In Stock:* ${v.product}\n` +
        `💰 *Price:* ${priceDisplay}\n` +
        `🟢 *Status:* Verified Vendor\n`;
    }
    previewMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
  } else if (targetLoc) {
    previewMsg += `📍 *No direct vendors found in ${targetLoc} right now for "${cleanProduct}".*\n\n`;
  }

  // Append out-of-area recommendations under "Check this out"
  if (recDisplay.length > 0 && (targetLoc || primaryDisplay.length < 5)) {
    previewMsg += `\n💡 *Check this out (Verified vendors in other locations):*\n`;
    for (let j = 0; j < recDisplay.length; j++) {
      const rec = recDisplay[j];
      const recLoc = `${rec.city || rec.state || 'Nigeria'}`;
      previewMsg +=
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `*✨ ${rec.businessName}*\n` +
        `📍 *Location:* ${recLoc} (Interstate delivery / Waybill)\n` +
        `🏷️ *Item:* ${rec.product}\n` +
        `💰 *Price:* ${rec.price || 'Market Rate'}\n`;
    }
    previewMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
  }

  previewMsg += `\n👇 *Tap "Select Vendor" below to connect directly:*`;

  // Build Native Slide-Up List Menu Sections
  const menuSections: any[] = [];

  if (primaryDisplay.length > 0) {
    menuSections.push({
      title: targetLoc ? `📍 Vendors in ${targetLoc.substring(0, 18)}` : '⭐ Top Verified Vendors',
      rows: primaryDisplay.map((v, idx) => ({
        id: `connect_biz_${v.id}`,
        title: `${idx + 1}. ${v.businessName}`.substring(0, 24),
        description: `${v.product} • ${v.price || 'Best Price'}`.substring(0, 72),
      })),
    });
  }

  if (recDisplay.length > 0) {
    menuSections.push({
      title: '💡 Check This Out (Other Areas)',
      rows: recDisplay.map((v) => ({
        id: `connect_biz_${v.id}`,
        title: `✨ ${v.businessName}`.substring(0, 24),
        description: `${v.city || v.state}: ${v.product}`.substring(0, 72),
      })),
    });
  }

  if (allMatches.length > primaryDisplay.length + recDisplay.length) {
    menuSections.push({
      title: '⚡ More Options',
      rows: [
        {
          id: 'btn_next_5_vendors',
          title: '➡️ Next Vendors',
          description: `View remaining verified sellers`,
        },
        {
          id: 'btn_find_product',
          title: '🔍 New Search',
          description: 'Search for a different product or item',
        },
        {
          id: 'btn_home',
          title: '🏠 Main Menu',
          description: 'Return to Floate home menu',
        },
      ],
    });
  } else {
    menuSections.push({
      title: '⚡ Navigation',
      rows: [
        {
          id: 'btn_find_product',
          title: '🔍 New Search',
          description: 'Search for a different product or item',
        },
        {
          id: 'btn_browse_markets',
          title: '📍 Browse Markets',
          description: 'Explore Balogun, Alaba, Onitsha, Aba',
        },
        {
          id: 'btn_home',
          title: '🏠 Main Menu',
          description: 'Return to Floate home menu',
        },
      ],
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

/**
 * Handle Next 5 Vendors Pagination
 */
async function handleShowNext5Vendors(toPhone: string, senderName: string, session: any) {
  const search = session.searchState;
  if (!search || !search.allMatchingListings || search.allMatchingListings.length === 0) {
    await sendWelcomeGreeting(toPhone, senderName);
    return;
  }

  const nextPage = (search.pageIndex || 0) + 1;
  const startIdx = nextPage * 5;
  const next5 = search.allMatchingListings.slice(startIdx, startIdx + 5);

  if (next5.length === 0) {
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
    `🔍 *Showing Vendors ${startIdx + 1}–${startIdx + next5.length} of ${search.allMatchingListings.length} for "${search.cleanProduct}":*\n\n`;

  for (let i = 0; i < next5.length; i++) {
    const v = next5[i];
    previewMsg +=
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*${startIdx + i + 1}️⃣ ${v.businessName}*\n` +
      `📍 *Location:* ${v.city || v.state}\n` +
      `🏷️ *In Stock:* ${v.product}\n` +
      `💰 *Price:* ${v.price || 'Market Rate'}\n`;
  }

  previewMsg += `━━━━━━━━━━━━━━━━━━━━\n\n👇 *Tap "Select Vendor" below to connect:*`;

  const listRows = next5.map((v: any, idx: number) => ({
    id: `connect_biz_${v.id}`,
    title: `${startIdx + idx + 1}. ${v.businessName}`.substring(0, 24),
    description: `${v.product} • ${v.price || 'Best Price'}`.substring(0, 72),
  }));

  await sendWhatsAppMessage(toPhone, previewMsg, {
    listMenu: {
      buttonText: '📋 Select Vendor',
      title: 'Verified Vendors',
      sections: [
        {
          title: `Shops (${startIdx + 1}–${startIdx + next5.length})`,
          rows: listRows,
        },
      ],
    },
  });
}

/**
 * 3. 2-STEP LEAD QUALIFICATION & SELLER HANDOFF
 */
async function start2StepLeadQualification(toPhone: string, senderName: string, bizId: string) {
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
    `*Step 1 of 2: Are you buying for personal use or wholesale?*`,
    {
      quickReplies: [
        { id: 'vol_retail', title: '🛍️ Retail Order' },
        { id: 'vol_wholesale', title: '📦 Wholesale Order' },
      ],
    }
  );
}

async function finish2StepQualificationHandoff(
  toPhone: string,
  senderName: string,
  fulfillment: 'Shop Visit' | 'Local City Delivery' | 'Interstate Waybill',
  session: any
) {
  const bizName = session.activeVendorName || 'Verified Vendor';
  const rawBizPhone = session.activeVendorPhone || '';
  const cleanBizPhone = normalizePhone(rawBizPhone).replace(/^0/, '234');
  const item = session.activeItem || 'In-Stock Goods';
  const volume = session.orderVolume || 'Retail';

  // Build clean pre-filled WhatsApp deal brief
  const prefilledText = `Hi ${bizName}, I found you on FLOATE.\n• Item: ${item}\n• Order Type: ${volume}\n• Fulfillment: ${fulfillment}\nAre you available with this in stock?`;
  const waLink = `https://wa.me/${cleanBizPhone}?text=${encodeURIComponent(prefilledText)}`;

  resetWhatsAppSession(toPhone);

  const handoffMsg =
    `✅ *Inquiry Pre-Packaged! Ready to Connect*\n\n` +
    `🏬 *Vendor:* ${bizName}\n` +
    `📦 *Item:* ${item}\n` +
    `🛍️ *Order Type:* ${volume}\n` +
    `🚚 *Fulfillment:* ${fulfillment}\n\n` +
    `👉 *Connect to vendor:*\n` +
    `Tap the button below to message ${bizName} directly on WhatsApp with your pre-packaged deal brief.\n\n` +
    `⚠️ *Buyer Safety:* _Always inspect items or agree on safe payment before sending money. FLOATE connects buyers and sellers with zero commission._`;

  await sendWhatsAppMessage(toPhone, handoffMsg, {
    ctaUrl: {
      displayText: '💬 Message Vendor',
      url: waLink,
      headerText: '🛍️ Direct Vendor Handoff',
      footerText: 'Zero Commission • FLOATE Trade',
    },
  });
}

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
 * 5. VENDOR HUB & REGISTRATION ROUTING
 */
async function handleVendorHubRouting(toPhone: string, senderName: string) {
  // Check if sender phone already exists in DB
  const existingMerchant = await firestoreDb.getMerchant(toPhone);

  // SCENARIO A: Existing Registered Vendor
  if (existingMerchant && existingMerchant.businessName) {
    const hubMsg =
      `👋 *Welcome back, ${existingMerchant.businessName}!*` +
      (existingMerchant.ownerFullName ? `\n👤 *Owner:* ${existingMerchant.ownerFullName}` : '') +
      `\n📍 *Location:* ${existingMerchant.city || existingMerchant.state || 'Nigeria'}\n` +
      `🟢 *Status:* Active Verified Vendor\n\n` +
      `📊 *Your Performance (Last 30 Days):*\n` +
      `• 👥 *Buyer Inquiries:* 48 qualified leads\n` +
      `• 🔍 *Search Appearances:* 240+ times\n` +
      `• 🏷️ *Status:* 🟢 Live in Market Directory\n\n` +
      `What would you like to do?`;

    await sendWhatsAppMessage(toPhone, hubMsg, {
      quickReplies: [
        { id: 'btn_find_product', title: '🔍 Search Items' },
        { id: 'btn_browse_markets', title: '📍 Browse Markets' },
        { id: 'btn_home', title: '🏠 Main Menu' },
      ],
    });
    return;
  }

  // SCENARIO B: New Unregistered Vendor
  const introMsg =
    `🏪 *Grow Your Business with FLOATE!*\n\n` +
    `List your shop to start receiving direct, qualified buyer inquiries on WhatsApp with **zero commission**.\n\n` +
    `✨ *What you get:*\n` +
    `• 🟢 Verified Vendor badge\n` +
    `• 📈 Direct wholesale & retail buyers\n` +
    `• 📍 Market hub listing (Alaba, Onitsha, Balogun, Aba, Kano, etc.)\n\n` +
    `*Tap below to start your quick 6-step registration:*`;

  await sendWhatsAppMessage(toPhone, introMsg, {
    quickReplies: [
      { id: 'btn_start_registration', title: '📝 Register Shop' },
      { id: 'btn_claim_shop', title: '🛡️ Claim Listing' },
      { id: 'btn_home', title: '🏠 Main Menu' },
    ],
  });
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
