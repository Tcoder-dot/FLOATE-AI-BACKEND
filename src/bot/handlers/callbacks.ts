import { Context, InlineKeyboard } from 'grammy';
import { statsManager } from '../statsManager.js';
import { userStore } from '../userStore.js';
import { sheetsDb, formatWhatsAppUrl, normalizePhone, escapeMarkdownText } from '../services/sheetsService.js';
import {
  firestoreDb,
  FirestoreService,
  isServiceItem,
  formatWhatsAppMsg,
  QualificationSessionDoc,
} from '../services/firestoreService.js';
import { getBusinessReplyKeyboard, replySafe, findExistingBusinessByName, findExistingBusinessByPhone } from '../helpers.js';
import { startUpdateWhatsappFlow } from '../flows.js';

export async function finishLeadQualification(
  ctx: any,
  qual: QualificationSessionDoc,
  username: string
) {
  const result = await firestoreDb.confirmStockAndDeductCredit(qual.id);

  const isService = isServiceItem(qual.item);
  const location = qual.deliveryLocation || 'N/A';
  const budget = qual.budget || 'Flexible / Market Rate';
  const urgency = qual.urgency || 'Flexible';

  const cleanPhone = normalizePhone(qual.merchantWhatsapp);
  const waMsg = formatWhatsAppMsg(qual.merchantName, qual.item, location, budget, urgency);
  const waLink = result.waLink || `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMsg)}`;
  const refId = result.lead?.ref || `FLT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  // Reset buyer user session state
  await firestoreDb.resetUserSession(qual.buyerId);

  const waKb = new InlineKeyboard().url('👉 Chat Direct on WhatsApp', waLink);

  const itemTitle = isService ? '💼 *Service Requested:*' : '📦 *Item Requested:*';
  const locTitle = isService ? '📍 *Your Location:*' : '📍 *Your Delivery Location:*';

  // 1. Deliver WhatsApp link and congratulation message to buyer
  try {
    const targetUserId = ctx.from?.id || qual.buyerId;
    await ctx.api.sendMessage(
      targetUserId,
      `🎉 *Connection Successful! Direct WhatsApp Access Granted*\n\n` +
      `🏬 *Merchant:* ${qual.merchantName}\n` +
      `${itemTitle} ${qual.item}\n` +
      `${locTitle} ${location}\n` +
      `💰 *Budget:* ${budget}\n` +
      `⚡ *Urgency:* ${urgency}\n` +
      `🏷️ *Transaction Ref:* \`${refId}\`\n\n` +
      `Congratulations! You have been successfully connected to *${qual.merchantName}*.\n\n` +
      `Tap the button below to message them directly on WhatsApp:\n` +
      `👉 [Chat Direct on WhatsApp](${waLink})\n\n` +
      `_We have also notified ${qual.merchantName} that a customer is reaching out on WhatsApp!_\n\n` +
      `⚠️ *Important Notice:* _Floate AI connects buyers and vendors. We are not affiliated with merchants and do not guarantee products, delivery, or payments. Please verify the seller before making payment. Floate is not responsible for transactions or disputes occurring off-platform._`,
      {
        parse_mode: 'Markdown',
        reply_markup: waKb,
      }
    );
  } catch (err: any) {
    console.warn(`[Buyer Notify Warning] Failed sending lead link to buyer ${qual.buyerId}:`, err);
  }

  // 2. Resolve merchant Telegram ID reliably
  let targetTelegramId = qual.merchantTelegramId;
  if (!targetTelegramId) {
    const mDoc = await firestoreDb.getMerchant(qual.merchantWhatsapp);
    if (mDoc) targetTelegramId = mDoc.telegramId || mDoc.userId;
  }
  if (!targetTelegramId) {
    const lst = sheetsDb.getListingById(qual.merchantId);
    if (lst) targetTelegramId = lst.telegramId || lst.userId;
  }

  // 3. Notify merchant on Telegram (NO confirm stock button required!)
  if (targetTelegramId) {
    try {
      const merchantItemTitle = isService ? '💼 *Service:*' : '📦 *Item:*';
      const merchantLocTitle = isService ? '📍 *Location:*' : '📍 *Delivery Location:*';

      let creditNotice = '';
      if (result.success && result.merchant) {
        if (FirestoreService.MONETIZATION_ENABLED) {
          creditNotice = `\n💳 *Lead Fee:* ₦200 NGN deducted\n💰 *Wallet Balance:* ₦${result.merchant.credit_balance.toLocaleString()} NGN`;
        } else {
          creditNotice = `\n🎁 *Launch Phase:* Free Qualified Lead (No Charge)`;
        }
      } else if (result.reason === 'INSUFFICIENT_FUNDS') {
        creditNotice = `\n⚠️ *Notice:* Wallet balance is low (₦0 NGN). Top up to maintain store search visibility!`;
      }

      await ctx.api.sendMessage(
        targetTelegramId,
        `🎉 *New Qualified Lead Sent to Your WhatsApp!*\n\n` +
        `🏬 *Merchant:* ${qual.merchantName}\n` +
        `${merchantItemTitle} ${qual.item}\n` +
        `${merchantLocTitle} ${location}\n` +
        `💰 *Budget:* ${budget}\n` +
        `⚡ *Urgency:* ${urgency}\n` +
        `👤 *Customer:* @${username || qual.buyerUsername || 'Buyer'}\n` +
        `🏷️ *Transaction Ref:* \`${refId}\`${creditNotice}\n\n` +
        `Floate AI has qualified this customer and sent them directly to your WhatsApp!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.warn(`[Merchant Ping Notice] Could not ping merchant Telegram ID ${targetTelegramId}:`, err);
    }
  }
}

export function buildStateKeyboard(page: 'popular' | 'ae' | 'fn' | 'oz' = 'popular'): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (page === 'popular') {
    kb.text('📍 Anambra', 'reg_state_sel_Anambra')
      .text('📍 Enugu', 'reg_state_sel_Enugu')
      .text('📍 Lagos', 'reg_state_sel_Lagos').row()
      .text('📍 Imo', 'reg_state_sel_Imo')
      .text('📍 Abia', 'reg_state_sel_Abia')
      .text('📍 FCT (Abuja)', 'reg_state_sel_FCT (Abuja)').row()
      .text('📍 Rivers', 'reg_state_sel_Rivers')
      .text('📍 Kano', 'reg_state_sel_Kano')
      .text('📍 Oyo', 'reg_state_sel_Oyo').row()
      .text('📍 Delta', 'reg_state_sel_Delta')
      .text('📍 Edo', 'reg_state_sel_Edo')
      .text('📍 Ebonyi', 'reg_state_sel_Ebonyi').row()
      .text('All States A to E ▶️', 'reg_state_page_ae');
  } else if (page === 'ae') {
    kb.text('Abia', 'reg_state_sel_Abia')
      .text('Adamawa', 'reg_state_sel_Adamawa')
      .text('Akwa Ibom', 'reg_state_sel_Akwa Ibom').row()
      .text('Anambra', 'reg_state_sel_Anambra')
      .text('Bauchi', 'reg_state_sel_Bauchi')
      .text('Bayelsa', 'reg_state_sel_Bayelsa').row()
      .text('Benue', 'reg_state_sel_Benue')
      .text('Borno', 'reg_state_sel_Borno')
      .text('Cross River', 'reg_state_sel_Cross River').row()
      .text('Delta', 'reg_state_sel_Delta')
      .text('Ebonyi', 'reg_state_sel_Ebonyi')
      .text('Edo', 'reg_state_sel_Edo').row()
      .text('Ekiti', 'reg_state_sel_Ekiti')
      .text('Enugu', 'reg_state_sel_Enugu').row()
      .text('◀️ Commercial', 'reg_state_page_popular')
      .text('States F to N ▶️', 'reg_state_page_fn');
  } else if (page === 'fn') {
    kb.text('FCT (Abuja)', 'reg_state_sel_FCT (Abuja)')
      .text('Gombe', 'reg_state_sel_Gombe')
      .text('Imo', 'reg_state_sel_Imo').row()
      .text('Jigawa', 'reg_state_sel_Jigawa')
      .text('Kaduna', 'reg_state_sel_Kaduna')
      .text('Kano', 'reg_state_sel_Kano').row()
      .text('Katsina', 'reg_state_sel_Katsina')
      .text('Kebbi', 'reg_state_sel_Kebbi')
      .text('Kogi', 'reg_state_sel_Kogi').row()
      .text('Kwara', 'reg_state_sel_Kwara')
      .text('Lagos', 'reg_state_sel_Lagos')
      .text('Nasarawa', 'reg_state_sel_Nasarawa').row()
      .text('Niger', 'reg_state_sel_Niger').row()
      .text('◀️ States A to E', 'reg_state_page_ae')
      .text('States O to Z ▶️', 'reg_state_page_oz');
  } else if (page === 'oz') {
    kb.text('Ogun', 'reg_state_sel_Ogun')
      .text('Ondo', 'reg_state_sel_Ondo')
      .text('Osun', 'reg_state_sel_Osun').row()
      .text('Oyo', 'reg_state_sel_Oyo')
      .text('Plateau', 'reg_state_sel_Plateau')
      .text('Rivers', 'reg_state_sel_Rivers').row()
      .text('Sokoto', 'reg_state_sel_Sokoto')
      .text('Taraba', 'reg_state_sel_Taraba')
      .text('Yobe', 'reg_state_sel_Yobe').row()
      .text('Zamfara', 'reg_state_sel_Zamfara').row()
      .text('◀️ States F to N', 'reg_state_page_fn')
      .text('◀️ Commercial', 'reg_state_page_popular');
  }

  return kb;
}

export function setupCallbackHandlers(bot: any) {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    const userId = ctx.from?.id || 0;
    const username = ctx.from?.first_name || 'User';
    statsManager.recordUpdate(userId);

    await ctx.answerCallbackQuery();

    // Admin Review Approval / Rejection Callbacks
    if (data?.startsWith('admin_approve_reg_')) {
      const merchantId = data.replace('admin_approve_reg_', '').trim();
      const pending = await firestoreDb.getPendingReviewMerchant(merchantId);
      if (!pending) {
        await ctx.reply(`⚠️ Pending registration for "${merchantId}" not found or already processed.`);
        return;
      }

      // 1. Mark status as APPROVED in Firestore
      await firestoreDb.updatePendingReviewStatus(merchantId, 'APPROVED');

      // 2. Add to active store directory (Google Sheets & Firestore)
      try {
        await sheetsDb.registerBusiness({
          userId: pending.userId || pending.whatsapp,
          businessName: pending.businessName,
          ownerFullName: pending.ownerFullName,
          whatsapp: pending.whatsapp,
          state: pending.state || 'Anambra',
          city: pending.city || 'Onitsha',
          listingType: (pending.listingType as any) || 'Product',
          category: pending.category || 'General',
          product: pending.product || 'General Goods',
          price: pending.price || 'Market Rate',
          negotiation: (pending.negotiation as any) || 'Yes',
        });
      } catch (e) {
        console.warn('[Admin Approve Sync Error]:', e);
      }

      // 3. Notify Merchant on Telegram / WhatsApp
      const approvalMsg =
        `🎉 *Good news! Your business listing has been approved!* 🎉\n\n` +
        `🏬 *Business:* ${pending.businessName}\n` +
        `📦 *Item:* ${pending.product}\n` +
        `📍 *Location:* ${pending.city}, ${pending.state}\n\n` +
        `Your store is now officially live on Floate AI! Buyers can now search and message you directly on WhatsApp. 🚀`;

      if (pending.telegramId) {
        try {
          await ctx.api.sendMessage(pending.telegramId, approvalMsg, {
            parse_mode: 'Markdown',
            reply_markup: getBusinessReplyKeyboard(),
          });
        } catch (tgErr) {
          console.warn('[Admin Approve Notify TG Error]:', tgErr);
        }
      }

      if (pending.whatsapp) {
        try {
          const { sendWhatsAppMessage } = await import('../services/whatsappService.js');
          await sendWhatsAppMessage(pending.whatsapp, approvalMsg);
        } catch (waErr) {
          console.warn('[Admin Approve Notify WA Error]:', waErr);
        }
      }

      await ctx.reply(`✅ *Approved:* Business "${pending.businessName}" is now active and live on Floate AI!`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    if (data?.startsWith('admin_reject_reg_')) {
      const merchantId = data.replace('admin_reject_reg_', '').trim();
      const pending = await firestoreDb.getPendingReviewMerchant(merchantId);
      if (!pending) {
        await ctx.reply(`⚠️ Pending registration for "${merchantId}" not found or already processed.`);
        return;
      }

      // 1. Mark status as REJECTED
      await firestoreDb.updatePendingReviewStatus(merchantId, 'REJECTED');

      const rejectMsg =
        `❌ *Registration Notice*\n\n` +
        `Your registration for "${pending.businessName}" could not be approved as it falls outside Floate's permitted business categories.`;

      if (pending.telegramId) {
        try {
          await ctx.api.sendMessage(pending.telegramId, rejectMsg, {
            parse_mode: 'Markdown',
          });
        } catch (tgErr) {}
      }

      if (pending.whatsapp) {
        try {
          const { sendWhatsAppMessage } = await import('../services/whatsappService.js');
          await sendWhatsAppMessage(pending.whatsapp, rejectMsg);
        } catch (waErr) {}
      }

      await ctx.reply(`❌ *Rejected:* Registration for "${pending.businessName}" was rejected.`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Cancel Search Session Trigger
    if (data === 'cancel_search_session') {
      await firestoreDb.resetUserSession(userId);
      userStore.clearFlowState(userId);
      await ctx.reply('❌ Search session cancelled. You can search for products or services anytime!', {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    // Lead Qualification Firewall - Buyer Connect Trigger
    if (data?.startsWith('connect_lead_') || data?.startsWith('buy_connect_')) {
      const listingId = data.replace(/^(connect_lead_|buy_connect_)/, '');
      const listing = sheetsDb.getListingById(listingId);
      if (!listing) {
        await ctx.reply('⚠️ Selected store listing was not found or is no longer active.');
        return;
      }

      const merchantDoc = await firestoreDb.getMerchant(listing.whatsapp);
      const tgId = listing.telegramId || listing.userId || merchantDoc?.telegramId || merchantDoc?.userId;
      const itemName = listing.product || listing.category || 'Item';
      const isService = isServiceItem(itemName, listing.category);

      const qualSession = await firestoreDb.createQualificationSession(
        userId,
        username,
        {
          id: listing.id || listing.whatsapp,
          name: listing.businessName,
          whatsapp: listing.whatsapp,
          telegramId: tgId,
        },
        itemName
      );

      const cancelKb = new InlineKeyboard().text('❌ Cancel Search', 'cancel_search_session');

      const itemLabel = isService ? '💼 *Service:*' : '📦 *Item:*';
      const locPrompt = isService
        ? `📍 **Step 1:** Please **type your location or city/area** into chat (e.g., *Enugu*, *Ikeja Lagos*, *Wuse II Abuja*):`
        : `📍 **Step 1:** Please **type your specific delivery neighborhood or market area** into chat (e.g., *Wuse II Abuja*, *Ikeja Lagos*, *Main Market Onitsha*):`;

      await ctx.reply(
        `🤝 *Direct Vendor Match (Step 1/3)*\n\n` +
        `🏬 *Merchant:* ${listing.businessName}\n` +
        `${itemLabel} ${itemName} (${listing.price || 'Contact for price'})\n\n` +
        `${locPrompt}\n\n` +
        `_This helps us connect you directly with a verified vendor in your area!_`,
        {
          parse_mode: 'Markdown',
          reply_markup: cancelKb,
        }
      );
      return;
    }

    // Lead Qualification Step 2 - Budget Selection Callback
    if (data?.startsWith('qual_budget_')) {
      const parts = data.replace('qual_budget_', '').split('_');
      const qualId = parts[0];
      const budgetValue = parts.slice(1).join('_');

      const session = await firestoreDb.getQualificationSession(qualId);
      if (!session) {
        await ctx.reply('⚠️ Qualification session expired. Please search again.');
        return;
      }

      const updatedQual = await firestoreDb.setQualificationBudget(qualId, budgetValue);
      if (updatedQual) {
        const isService = isServiceItem(updatedQual.item);
        const urgencyKb = new InlineKeyboard()
          .text('⚡ Immediately (Today)', `qual_urgency_${qualId}_Immediately`)
          .row()
          .text('📅 Within 24-48 Hours', `qual_urgency_${qualId}_Within 24-48 Hours`)
          .row()
          .text('⌛ Flexible / No Rush', `qual_urgency_${qualId}_Flexible`)
          .row()
          .text('➡️ Skip', `qual_urgency_${qualId}_Skip`);

        await ctx.reply(
          `⚡ *Direct Vendor Match (Step 3/3)*\n\n` +
          `Do you need this ${isService ? 'service' : 'item'} urgently?\n\n` +
          `_Select an option below or type your timeframe into chat:_`,
          {
            parse_mode: 'Markdown',
            reply_markup: urgencyKb,
          }
        );
      }
      return;
    }

    // Lead Qualification Step 3 - Urgency Selection Callback
    if (data?.startsWith('qual_urgency_')) {
      const parts = data.replace('qual_urgency_', '').split('_');
      const qualId = parts[0];
      const urgencyValue = parts.slice(1).join('_');

      const updatedQual = await firestoreDb.setQualificationUrgency(qualId, urgencyValue);
      if (updatedQual) {
        await finishLeadQualification(ctx, updatedQual, username);
      } else {
        await ctx.reply('⚠️ Qualification session expired. Please search again.');
      }
      return;
    }

    // Legacy Merchant Stock Confirmation Fallback
    if (data?.startsWith('confirm_lead_')) {
      const qualId = data.replace('confirm_lead_', '');
      const qual = await firestoreDb.getQualificationSession(qualId);
      if (qual) {
        await finishLeadQualification(ctx, qual, username);
      } else {
        await ctx.reply('⚠️ Qualification session not found or expired.');
      }
      return;
    }

    // Topup Bundle Selection Callbacks
    if (data?.startsWith('topup_bundle_')) {
      const amountStr = data.replace('topup_bundle_', '');
      const amount = parseInt(amountStr, 10) || 1000;
      const leadsCount = Math.floor(amount / 200);

      await ctx.reply(
        `💳 *Flutterwave Credit Top-Up*\n\n` +
        `• *Selected Bundle:* ₦${amount.toLocaleString()} NGN (${leadsCount} Qualified Leads)\n` +
        `• *Merchant ID:* \`${userId}\`\n\n` +
        `🔒 Payment Gateway Webhook Integration (/api/flutterwave-webhook) is configured and awaiting live API keys.\n\n` +
        `Send /wallet anytime to manage your balance.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // State Page Navigation
    if (data?.startsWith('reg_state_page_')) {
      const page = data.replace('reg_state_page_', '') as 'popular' | 'ae' | 'fn' | 'oz';
      const kb = buildStateKeyboard(page);
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: kb });
      } catch {
        await ctx.reply(`*Step 4 of 10:* Select your **State**:`, {
          parse_mode: 'Markdown',
          reply_markup: kb,
        });
      }
      return;
    }

    // State Selection
    if (data?.startsWith('reg_state_sel_')) {
      const selectedState = data.replace('reg_state_sel_', '');
      userStore.setFlowState(userId, 'AWAITING_CITY', {
        businessState: selectedState,
      });

      await ctx.reply(
        `State set to *${selectedState}*! 📍\n\n` +
        `*Step 5 of 10:* What **City, Town, or Market Area** within ${selectedState} is your business located in?\n` +
        `_(Example: Onitsha Main Market, Independence Layout, Agbani, Wuse 2, Ikeja, Aba Market, Owerri Central)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Listing Type Selection Callbacks (Registration Flow)
    if (data?.startsWith('reg_type_sel_')) {
      const typeKey = data.replace('reg_type_sel_', '');
      let chosenType = 'Product';
      if (typeKey === 'service') chosenType = 'Service';
      else if (typeKey === 'both') chosenType = 'Product & Service';

      userStore.setFlowState(userId, 'AWAITING_CATEGORY', {
        listingType: chosenType,
      });

      await ctx.reply(
        `Listing Type set to *${chosenType}*!\n\n` +
        `*Step 7 of 10:* What is your **Business Category**?\n` +
        `_(Example: Fashion, Footwear, Phones & Accessories, Electronics, Computing, Cleaning, Logistics)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Listing Type Selection Callbacks (Add Product Flow)
    if (data?.startsWith('add_type_sel_')) {
      const typeKey = data.replace('add_type_sel_', '');
      let chosenType = 'Product';
      if (typeKey === 'service') chosenType = 'Service';
      else if (typeKey === 'both') chosenType = 'Product & Service';

      const profile = userStore.getProfile(userId, username);
      userStore.setFlowState(userId, 'AWAITING_ADD_PRODUCT_PRICE', {
        tempListingType: chosenType,
      });

      await ctx.reply(
        `Listing Type set to *${chosenType}*!\n\n` +
        `*Step 3 of 4:* What is the **Price** or rate for *${profile.tempProduct || 'this item'}*?\n` +
        `_(Example: ₦8,000, ₦250,000, 15k, Negotiable)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Negotiation Selection Callbacks (Registration Flow)
    if (data === 'reg_neg_yes' || data === 'reg_neg_no') {
      const isNeg: 'Yes' | 'No' = data === 'reg_neg_yes' ? 'Yes' : 'No';
      const profile = userStore.setFlowState(userId, 'AWAITING_SELFIE_VERIFICATION', {
        firstNegotiable: isNeg,
      });

      await ctx.reply(
        `Price negotiability set to *${isNeg === 'Yes' ? 'Negotiable' : 'Fixed'}*.\n\n` +
        `📸 *Merchant Photo Verification*\n\n` +
        `To confirm a real person is behind *${profile.businessName}* and protect buyers, please send a quick **selfie or clear photo of your face**.\n\n` +
        `💡 *Helpful Tips:*\n` +
        `• A normal portrait or selfie with your face clearly visible.\n` +
        `• Natural or indoor lighting works great, no studio setup needed!\n` +
        `• No AI avatars, cartoon filters, or group photos.\n\n` +
        `_This takes just 2 seconds and will serve as your store profile picture in search results!_ 📸`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Skip / Done with Registration Product Photos
    if (data === 'reg_skip_prod_photos' || data === 'reg_done_prod_photos') {
      const profile = userStore.setFlowState(userId, 'AWAITING_CONFIRMATION');

      const kb = new InlineKeyboard()
        .text('✅ CONFIRM & SAVE STORE', 'reg_confirm_save')
        .row()
        .text('🔄 START OVER', 'reg_restart');

      const photoCount = profile.productImages?.length || 0;
      const photoStatus = photoCount > 0 ? `🖼️ *Product Photos:* ${photoCount} attached` : '🖼️ *Product Photos:* None';
      const selfieStatus = profile.identityVerified ? '✅ *Identity Status:* Verified (Live Selfie Saved)' : '⏳ *Identity Status:* Pending';
      const ownerDisplay = profile.ownerFullName ? `• *Owner (Confidential):* ${profile.ownerFullName} 🔒\n` : '';

      await ctx.reply(
        `📋 *Please Confirm Your Store Details:*\n\n` +
        `• *Business Name:* ${profile.businessName}\n` +
        ownerDisplay +
        `• *WhatsApp:* ${profile.businessWhatsapp}\n` +
        `• *State:* ${profile.businessState}\n` +
        `• *City / Area:* ${profile.businessCity}\n` +
        `• *Listing Type:* ${profile.listingType || 'Product'}\n` +
        `• *Category:* ${profile.businessCategory}\n` +
        `• *First Product/Service:* ${profile.firstProduct}\n` +
        `• *Price:* ${profile.firstPrice}\n` +
        `• *Negotiable:* ${profile.firstNegotiable}\n` +
        `• ${selfieStatus}\n` +
        `• ${photoStatus}\n\n` +
        `Tap **✅ CONFIRM & SAVE STORE** to complete your registration!`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
      return;
    }

    // Negotiation Selection Callbacks (Add Product Flow)
    if (data === 'add_neg_yes' || data === 'add_neg_no') {
      const isNeg: 'Yes' | 'No' = data === 'add_neg_yes' ? 'Yes' : 'No';
      const profile = userStore.setFlowState(userId, 'AWAITING_ADD_PRODUCT_IMAGES', {
        tempNegotiable: isNeg,
        tempProductImages: [],
      });

      const skipKb = new InlineKeyboard().text('➡️ Skip / Done with Photos', 'add_skip_prod_photos');

      await ctx.reply(
        `Price negotiability set to *${isNeg === 'Yes' ? 'Negotiable' : 'Fixed'}*.\n\n` +
        `🖼️ *Step 4 of 4: Product Photos (Optional, Up to 4 Images)*\n\n` +
        `Attach up to **4 photos** of *${profile.tempProduct}* for buyers to see in search results.\n\n` +
        `• Send product photo(s) into chat one-by-one, OR\n` +
        `• Tap **➡️ Skip / Done with Photos** to publish without photos.`,
        { parse_mode: 'Markdown', reply_markup: skipKb }
      );
      return;
    }

    // Skip / Done with Add Product Photos
    if (data === 'add_skip_prod_photos' || data === 'add_done_prod_photos') {
      const profile = userStore.setFlowState(userId, 'AWAITING_ADD_PRODUCT_CONFIRM');

      const kb = new InlineKeyboard()
        .text('✅ CONFIRM ADD PRODUCT', 'btn_add_prod_confirm')
        .row()
        .text('❌ CANCEL', 'btn_add_prod_cancel');

      const photoCount = profile.tempProductImages?.length || 0;
      const photoStatus = photoCount > 0 ? `🖼️ *Product Photos:* ${photoCount} attached` : '🖼️ *Product Photos:* None';

      await ctx.reply(
        `📋 *Confirm New Listing Details:*\n\n` +
        `• *Item Name:* ${profile.tempProduct}\n` +
        `• *Type:* ${profile.tempListingType || 'Product'}\n` +
        `• *Price:* ${profile.tempPrice}\n` +
        `• *Negotiable:* ${profile.tempNegotiable}\n` +
        `• ${photoStatus}\n\n` +
        `Tap **✅ CONFIRM ADD PRODUCT** to publish this item!`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
      return;
    }

    // Confirmation & Saving Initial Store Registration
    if (data === 'reg_confirm_save') {
      const profile = userStore.getProfile(userId, username);
      if (profile.registrationStep === 'SAVING') {
        return; // Double click protection
      }

      const bizName = (profile.businessName || '').trim();
      const firstProd = (profile.firstProduct || '').trim();

      if (!bizName || !firstProd) {
        await ctx.reply('⚠️ Missing registration data. Please type /register to start again.');
        return;
      }

      // Check if business name is already registered by another user
      const existingBiz = findExistingBusinessByName(bizName, userId);
      if (existingBiz) {
        await replySafe(
          ctx,
          `⚠️ *Business Name Conflict*\n\n` +
          `A store named "*${escapeMarkdownText(existingBiz.businessName)}*" is already registered on Floate AI.\n\n` +
          `Please edit your business name to avoid clashing.\n` +
          `💡 *Suggestions:*\n` +
          `• "*${escapeMarkdownText(bizName)} (Onitsha)*"\n` +
          `• "*${escapeMarkdownText(bizName)} Hub*"\n` +
          `• "*${escapeMarkdownText(bizName)} & Sons*"\n\n` +
          `Send your updated unique business name now:`
        );
        userStore.setFlowState(userId, 'AWAITING_NAME');
        return;
      }

      // Check if WhatsApp is already registered by another user
      if (profile.businessWhatsapp) {
        const existingByPhone = findExistingBusinessByPhone(profile.businessWhatsapp, userId);
        if (existingByPhone) {
          await replySafe(
            ctx,
            `⚠️ *WhatsApp Number Already Linked*\n\n` +
            `The number *${escapeMarkdownText(profile.businessWhatsapp)}* is registered to "*${escapeMarkdownText(existingByPhone.businessName)}*".\n\n` +
            `• Use /claim if you own that store.\n` +
            `• Or enter a different WhatsApp phone number below:`
          );
          userStore.setFlowState(userId, 'AWAITING_WHATSAPP');
          return;
        }
      }

      // Immediately set step to SAVING to prevent duplicate entries
      userStore.setFlowState(userId, 'SAVING');

      try {
        // Run Gemini Registration Safety Gate Check
        const { auditBusinessRegistrationWithGemini } = await import('../services/registrationSafetyService.js');
        const safetyAudit = await auditBusinessRegistrationWithGemini({
          businessName: bizName,
          category: profile.businessCategory || 'General',
          productDescription: firstProd,
        });

        console.log(`[Safety Gate TG] User ${userId} (${bizName}): Decision=${safetyAudit.decision} (Reason: ${safetyAudit.reason})`);

        // TIER 1: HARD BLOCK (Immediate rejection, no admin review)
        if (safetyAudit.decision === 'HARD_BLOCK') {
          userStore.clearFlowState(userId);
          console.warn(`[SAFETY HARD BLOCK TG] Auto-rejected ${userId} (${bizName}): ${safetyAudit.reason}`);

          await replySafe(
            ctx,
            `❌ *Registration Notice*\n\n` +
            `This registration cannot be approved as it falls outside Floate's permitted business categories.`,
            {
              parse_mode: 'Markdown',
            }
          );
          return;
        }

        // TIER 2: PENDING REVIEW (Regulated / Age-restricted goods -> PENDING_REVIEW)
        if (safetyAudit.decision === 'PENDING_REVIEW') {
          userStore.clearFlowState(userId);

          const phoneKey = profile.businessWhatsapp || String(userId);
          const pendingDoc = await firestoreDb.savePendingReviewMerchant({
            id: phoneKey,
            userId,
            telegramId: userId,
            businessName: bizName,
            ownerFullName: profile.ownerFullName,
            whatsapp: profile.businessWhatsapp || '',
            state: profile.businessState || 'Anambra',
            city: profile.businessCity || 'Onitsha',
            listingType: profile.listingType || 'Product',
            category: profile.businessCategory || 'General',
            product: firstProd,
            price: profile.firstPrice || 'Negotiable',
            negotiation: profile.firstNegotiable || 'Yes',
            status: 'PENDING_REVIEW',
            safetyReason: safetyAudit.reason,
            safetyFlags: safetyAudit.categoryFlags,
          });

          const { alertAdminPendingReviewRegistration } = await import('../services/whatsappAdminService.js');
          await alertAdminPendingReviewRegistration({
            merchantId: pendingDoc.id,
            businessName: bizName,
            phone: profile.businessWhatsapp || String(userId),
            category: profile.businessCategory || 'General',
            product: firstProd,
            price: profile.firstPrice || 'Negotiable',
            location: `${profile.businessCity || 'Onitsha'}, ${profile.businessState || 'Anambra'}`,
            ownerFullName: profile.ownerFullName,
            reason: safetyAudit.reason,
            flags: safetyAudit.categoryFlags,
          });

          await replySafe(
            ctx,
            `⏳ *Thanks for registering!*\n\n` +
            `Your business is under review and you'll be notified once approved, usually within 24 hours.`,
            {
              parse_mode: 'Markdown',
            }
          );
          return;
        }

        // TIER 3: AUTO_APPROVE (Standard Commerce)
        const regResult = await sheetsDb.registerBusiness({
          userId,
          businessName: bizName,
          ownerFullName: profile.ownerFullName,
          whatsapp: profile.businessWhatsapp || '08000000000',
          state: profile.businessState || 'Anambra',
          city: profile.businessCity || 'Onitsha',
          listingType: profile.listingType || 'Product',
          category: profile.businessCategory || 'General',
          product: firstProd,
          price: profile.firstPrice || 'Negotiable',
          negotiation: profile.firstNegotiable || 'Yes',
          profileImageUrl: profile.profileImageUrl,
          verificationMediaUrl: profile.verificationMediaUrl,
          productImages: profile.productImages,
          identityVerified: profile.identityVerified,
        });

        const listing = regResult.listing || {
          businessName: bizName,
          product: firstProd,
          listingType: profile.listingType || 'Product',
          price: profile.firstPrice || 'Negotiable',
          negotiation: profile.firstNegotiable || 'Yes',
          city: profile.businessCity || 'Onitsha',
          state: profile.businessState || 'Anambra',
          identityVerified: profile.identityVerified,
        };

        userStore.clearFlowState(userId);

        let syncStatusNote = '';
        if (regResult.success) {
          syncStatusNote = `\n\n📊 *Google Sheets Status:* Live Sync Active`;
        } else {
          syncStatusNote = `\n\n⚠️ *Google Sheets Sync Notice:* Saved to local memory and queued for Sheets sync.`;
        }

        const safeBizName = escapeMarkdownText(listing.businessName);
        const safeProduct = escapeMarkdownText(listing.product);
        const safeType = escapeMarkdownText(listing.listingType || 'Product');
        const safePrice = escapeMarkdownText(listing.price);
        const safeCity = escapeMarkdownText(listing.city);
        const safeState = escapeMarkdownText(listing.state);

        await replySafe(
          ctx,
          `🎉 Congratulations, *${safeBizName}*, you're officially live on Floate AI!\n\n` +
          `Here's what's now working for you:\n` +
          `📦 *Item:* ${safeProduct} (${safeType}), ${safePrice}${listing.negotiation === 'Yes' ? ' (Negotiable)' : ' (Fixed)'}\n` +
          `📍 *Location:* ${safeCity}, ${safeState}\n` +
          `🔒 *Identity Verification:* ${listing.identityVerified ? '✓ Live Selfie Verified' : 'Pending'}\n\n` +
          `Buyers searching for products or services like yours can now find you and message you directly on WhatsApp, no ads, no extra work from you.\n\n` +
          `Want to list more? Send /addproduct anytime.\n` +
          `Curious how you're doing? Send /mystats to see your search activity.\n` +
          `Need to fix something? /editproduct has you covered.` +
          syncStatusNote + `\n\n` +
          `Welcome aboard, let's get you some customers! 🚀`,
          {
            parse_mode: 'Markdown',
            reply_markup: getBusinessReplyKeyboard(),
          }
        );
      } catch (err) {
        console.error('[Registration Error]', err);
        userStore.setFlowState(userId, 'AWAITING_CONFIRMATION');
        await replySafe(
          ctx,
          `⚠️ An error occurred while saving your store. Your details are preserved.\n\n` +
          `Please tap **✅ Confirm & Go Live** below or type "confirm" to try saving again:`,
          {
            reply_markup: new InlineKeyboard().text('✅ Confirm & Go Live', 'reg_confirm_save'),
          }
        );
      }
      return;
    }

    // Add Product Confirmation Callbacks
    if (data === 'btn_add_prod_confirm') {
      const profile = userStore.getProfile(userId, username);
      if (!profile.tempProduct || !profile.tempPrice) {
        await ctx.reply('⚠️ Missing product data. Please use /addproduct to start again.');
        return;
      }

      const addResult = await sheetsDb.addNewProductListing(
        userId,
        profile.tempProduct,
        profile.tempPrice,
        profile,
        profile.tempListingType,
        profile.tempNegotiable || 'Yes',
        profile.tempProductImages
      );
      const listing = addResult.listing;

      userStore.clearFlowState(userId);

      let syncStatusNote = '';
      if (addResult.success) {
        syncStatusNote = `\n\n📊 *Google Sheets Status:* Saved to Sheet (${sheetsDb.getSpreadsheetId()})`;
      } else {
        syncStatusNote = `\n\n⚠️ *Google Sheets Sync Notice:* ${addResult.error || 'Failed to append row'}\n_(Saved to bot local memory)_`;
      }

      await ctx.reply(
        `🎉 *${listing.product}* is now live in your store catalog!\n\n` +
        `Here's what's updated:\n` +
        `📦 *Item:* ${listing.product}, ${listing.price}${listing.negotiation === 'Yes' ? ' (Negotiable)' : ' (Fixed)'}\n` +
        `🏬 *Store:* ${listing.businessName} (${listing.city}, ${listing.state})\n` +
        `${listing.productImages && listing.productImages.length > 0 ? `🖼️ *Images:* ${listing.productImages.length} attached\n` : ''}\n` +
        `Buyers searching for "${listing.product}" in your region can now find this item and message you directly on WhatsApp!\n\n` +
        `• Want to list more? Send /addproduct anytime.\n` +
        `• Track store performance? Send /mystats\n` +
        `• Need to update something? Send /editproduct` +
        syncStatusNote + `\n\n` +
        `Keep building your catalog and growing your reach! 🚀`,
        {
          parse_mode: 'Markdown',
          reply_markup: getBusinessReplyKeyboard(),
        }
      );
      return;
    }

    if (data === 'btn_add_prod_cancel') {
      userStore.clearFlowState(userId);
      await ctx.reply(
        `No problem! We've stopped adding this item and returned you to your business dashboard. 😊\n\nWhenever you're ready to list a new product, tap **📦 Add Product** below!`,
        { reply_markup: getBusinessReplyKeyboard() }
      );
      return;
    }

    // Delete Business Confirmation Callbacks
    if (data === 'btn_del_biz_confirm') {
      const deletedCount = sheetsDb.deleteBusinessByUserId(userId);
      userStore.clearFlowState(userId);
      userStore.setRole(userId, 'BUYER', username);

      await ctx.reply(
        `🗑️ *Business Removed*\n\n` +
        `Your store and all ${deletedCount} product listing${deletedCount === 1 ? '' : 's'} have been removed from Floate AI.\n\n` +
        `We'd love to have you back anytime! You can register a new store whenever you're ready by typing \`/register\`.`,
        {
          parse_mode: 'Markdown',
          reply_markup: { remove_keyboard: true },
        }
      );
      return;
    }

    if (data === 'btn_del_biz_cancel') {
      userStore.clearFlowState(userId);
      await ctx.reply(
        `Glad to hear it! Your store and product listings remain fully active and searchable across Nigeria. 🚀`,
        {
          reply_markup: getBusinessReplyKeyboard(),
        }
      );
      return;
    }

    // Edit Item Selection Callbacks
    if (data?.startsWith('edit_item_')) {
      const id = data.replace('edit_item_', '');
      const listing = sheetsDb.getListingById(id);
      if (!listing) {
        await ctx.reply('⚠️ Item not found or deleted.');
        return;
      }

      userStore.setFlowState(userId, 'AWAITING_EDIT_ACTION', {
        selectedListingId: id,
      });

      const kb = new InlineKeyboard()
        .text('🏷️ Edit Product Name', `edit_act_name_${id}`)
        .text('💰 Edit Price', `edit_act_price_${id}`)
        .row()
        .text('📱 Update WhatsApp Number', `edit_act_wa_${id}`)
        .text('🗑️ Delete Product', `edit_act_del_${id}`)
        .row()
        .text('❌ Cancel', 'edit_act_cancel');

      await ctx.reply(
        `✏️ *Managing Item: ${listing.product}*\n` +
        `• *Current Price:* ${listing.price}\n` +
        `• *Store Location:* ${listing.city}, ${listing.state}\n\n` +
        `What would you like to update?`,
        {
          parse_mode: 'Markdown',
          reply_markup: kb,
        }
      );
      return;
    }

    // Edit Name Callback
    if (data?.startsWith('edit_act_name_')) {
      const id = data.replace('edit_act_name_', '');
      const listing = sheetsDb.getListingById(id);
      userStore.updateRegistration(userId, {
        selectedListingId: id,
        selectedEditAction: 'NAME',
        registrationStep: 'AWAITING_EDIT_NEW_VALUE',
      });
      await ctx.reply(
        `🏷️ Enter the **New Product Name** for *${listing?.product || 'this item'}*:`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Edit Price Callback
    if (data?.startsWith('edit_act_price_')) {
      const id = data.replace('edit_act_price_', '');
      const listing = sheetsDb.getListingById(id);
      userStore.setFlowState(userId, 'AWAITING_EDIT_NEW_VALUE', {
        selectedListingId: id,
        selectedEditAction: 'PRICE',
      });
      await ctx.reply(
        `💰 Enter the **New Price** for *${listing?.product || 'this item'}* (currently ${listing?.price || 'N/A'}):`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Update WhatsApp Callback
    if (data?.startsWith('edit_act_wa_') || data === 'edit_act_whatsapp_global') {
      await startUpdateWhatsappFlow(ctx, userId);
      return;
    }

    // Delete Prompt Callback
    if (data?.startsWith('edit_act_del_')) {
      const id = data.replace('edit_act_del_', '');
      const listing = sheetsDb.getListingById(id);
      if (!listing) {
        await ctx.reply('⚠️ Item not found.');
        return;
      }

      const kb = new InlineKeyboard()
        .text('⚠️ YES, Delete Product', `edit_confirm_del_${id}`)
        .text('❌ Cancel', 'edit_act_cancel');

      await ctx.reply(
        `⚠️ *Confirm Delete*\n\n` +
        `Are you sure you want to delete *${listing.product}* (${listing.price}) from your store?`,
        {
          parse_mode: 'Markdown',
          reply_markup: kb,
        }
      );
      return;
    }

    // Confirm Delete Callback
    if (data?.startsWith('edit_confirm_del_')) {
      const id = data.replace('edit_confirm_del_', '');
      const listing = sheetsDb.getListingById(id);
      const name = listing?.product || 'Item';
      sheetsDb.deleteListing(id);

      userStore.clearFlowState(userId);

      await ctx.reply(
        `🗑️ *Product Deleted*\n\n` +
        `*${name}* has been removed from your store catalog.`,
        {
          parse_mode: 'Markdown',
          reply_markup: getBusinessReplyKeyboard(),
        }
      );
      return;
    }

    // Edit Cancel
    if (data === 'edit_act_cancel') {
      userStore.clearFlowState(userId);
      await ctx.reply(
        `All set! We've returned to your business dashboard. Your listings remain untouched. 😊`,
        { reply_markup: getBusinessReplyKeyboard() }
      );
      return;
    }

    // Edit / Restart Registration
    if (data === 'reg_edit_restart') {
      userStore.setFlowState(userId, 'AWAITING_NAME', {
        businessName: '',
        ownerFullName: '',
        businessWhatsapp: '',
        businessState: '',
        businessCity: '',
        listingType: '',
        businessCategory: '',
        firstProduct: '',
        firstPrice: '',
      });

      await ctx.reply(
        `🔄 *Let's start over.*\n\n` +
        `*Step 1 of 10:* What is your **Business or Shop Name**?\n` +
        `_(Example: Chiks Electronics, Kemi Fashion Hub, Onitsha Footwear)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    switch (data) {
      case 'cmd_start_register':
      case 'role_business': {
        userStore.setRole(userId, 'BUSINESS', username);
        userStore.setFlowState(userId, 'AWAITING_NAME');
        await sheetsDb.logInteraction(userId, username, 'ROLE_SELECTED', 'BUSINESS');

        await ctx.reply(
          `🏪 *Welcome to Floate AI Business Registration!*\n\n` +
          `It takes under 2 minutes to set up your store, and buyers across Nigeria are already searching for products like yours every day.\n\n` +
          `Let's get your store live!\n\n` +
          `*Step 1 of 10:* What is your **Business or Shop Name**?\n` +
          `_(Example: Chiks Electronics, Kemi Fashion Hub, Onitsha Footwear)_`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'role_buyer': {
        userStore.setRole(userId, 'BUYER', username);
        await sheetsDb.logInteraction(userId, username, 'ROLE_SELECTED', 'BUYER');

        const buyerKeyboard = new InlineKeyboard()
          .text('🔍 Search Products', 'cmd_prompt_search')
          .text('🏢 Register Business', 'cmd_start_register')
          .row()
          .text('💬 Ask Floate AI Assistant', 'cmd_ask_ai');

        await ctx.reply(
          `🛍️ *Welcome to Floate AI, ${username}!*\n\n` +
          `Simply type or send a voice note describing what you're looking for (e.g. *"I want leather slippers, 5k, Onitsha"*).\n\n` +
          `No commands needed! Speak or type in English, Pidgin, Yoruba, or Igbo.`,
          {
            parse_mode: 'Markdown',
            reply_markup: buyerKeyboard,
          }
        );
        break;
      }

      case 'cmd_prompt_search': {
        userStore.clearFlowState(userId);
        const firstName = username || 'there';
        await ctx.reply(
          `Alright ${firstName}, what product would you like to find?\n\n` +
          `💬 _You can type any item, brand, or location into this chat (e.g. "Leather slippers 5k Onitsha" or "iPhone 13 Lagos"), or simply send a voice note!_`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'cmd_ask_ai':
        await ctx.reply('💬 Ask Floate AI any shopping question or location advice directly in chat!');
        break;

      case 'inv_confirm': {
        const result = await firestoreDb.confirmAndPublishDraft(userId, ctx.api);
        userStore.clearFlowState(userId);
        try {
          await ctx.editMessageText(result.publishedText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          await ctx.reply(result.publishedText, { parse_mode: 'Markdown' });
        }
        break;
      }

      case 'inv_edit': {
        userStore.setFlowState(userId, 'AWAITING_EDIT_INVENTORY_DRAFT');
        await ctx.reply(
          `✏️ *Edit Inventory Details*\n\n` +
          `Please send an updated voice note, photo with caption, or type the corrected inventory details into chat (e.g. \`Nike Air Jordans, ₦30,000, 40 units, Sizes 41-44\`):\n\n` +
          `_We will re-extract and present an updated draft for your review!_`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'inv_cancel': {
        firestoreDb.cancelDraft(userId);
        userStore.clearFlowState(userId);
        try {
          await ctx.editMessageText(
            `No problem! We've cancelled this inventory sync. Nothing was saved or changed in your store catalog. 😊\n\nWhenever you'd like to sync new stock, send a voice note, photo, or message anytime!`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
          );
        } catch {
          await ctx.reply(
            `No problem! We've cancelled this inventory sync. Nothing was saved or changed in your store catalog. 😊`,
            { parse_mode: 'Markdown' }
          );
        }
        break;
      }

      case 'cmd_status': {
        const stats = statsManager.getStats();
        await ctx.reply(
          `⚡ *Floate AI Network Status*\n\n` +
          `• Queries Processed: ${stats.updatesProcessed}\n` +
          `• Connected Users: ${stats.activeUsersCount}\n` +
          `• Network Latency: ${stats.lastActive || 'N/A'}`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      default:
        await ctx.reply(`Received action: ${data}`);
        break;
    }
  });
}


