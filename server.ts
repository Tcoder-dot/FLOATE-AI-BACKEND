import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { webhookCallback } from 'grammy';
import { config, isBotConfigured, isWhatsAppConfigured } from './src/bot/config.js';
import { getBotInstance } from './src/bot/bot.js';
import { statsManager } from './src/bot/statsManager.js';
import { processSimulatedMessage } from './src/bot/services/botSimulator.js';
import { sheetsDb } from './src/bot/services/sheetsService.js';
import { firestoreDb } from './src/bot/services/firestoreService.js';
import { executeSearch } from './src/bot/services/searchService.js';
import { handleWhatsAppVerification, handleWhatsAppWebhook, sendWhatsAppMessage } from './src/bot/services/whatsappService.js';


const getFilename = () => {
  if (typeof __filename !== 'undefined') return __filename;
  if (import.meta && import.meta.url) {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      return '';
    }
  }
  return '';
};

const currentFilename = getFilename();
const currentDirname = typeof __dirname !== 'undefined' ? __dirname : (currentFilename ? path.dirname(currentFilename) : process.cwd());

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // CORS middleware for API endpoints
  app.use('/api', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // 1. Health check endpoints
  app.get('/health', (_req, res) => {
    res.status(200).send('Bot is running');
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'Telegram Bot Logic Engine',
    });
  });

  // Website Search API Endpoint for floate.xyz
  app.options('/api/search', (_req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    res.sendStatus(204);
  });

  app.post('/api/search', async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    try {
      const expectedApiKey = process.env.FLOATE_API_KEY || 'floate_live_sk_7f8a92b3c4e5d6';
      const providedApiKey =
        (req.headers['x-api-key'] as string) ||
        (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '') ||
        (req.query.apiKey as string) ||
        (req.body && req.body.apiKey);

      if (!providedApiKey || providedApiKey !== expectedApiKey) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized: Invalid or missing API key. Provide x-api-key header or apiKey in payload.',
        });
      }

      const { query, search, location, budget } = req.body || {};
      const searchQuery = query || search || '';

      if (!searchQuery) {
        return res.status(400).json({
          success: false,
          error: 'Search query is required. Provide {"query": "item name"}.',
        });
      }

      const searchResult = await executeSearch({
        query: searchQuery,
        location,
        budget,
      });

      return res.json({
        success: true,
        query: searchResult.query,
        totalMatches: searchResult.totalMatches,
        results: searchResult.results,
        spotlightListings: searchResult.spotlightListings,
        organicListings: searchResult.organicListings,
        exactMatches: searchResult.exactMatches,
        categoryMatches: searchResult.categoryMatches,
        moreBusinessesDeepLink: searchResult.moreBusinessesDeepLink,
        moreBusinessesWhatsAppDeepLink: searchResult.moreBusinessesWhatsAppDeepLink,
      });
    } catch (error: any) {
      console.error('[API /api/search Error]:', error);
      return res.status(500).json({
        success: false,
        error: 'An error occurred while processing your search request.',
      });
    }
  });

  // 2. Bot Status and Configuration details
  app.get('/api/bot/status', (_req, res) => {
    const isConfigured = isBotConfigured();
    const isWaConfigured = isWhatsAppConfigured();
    const stats = statsManager.getStats();

    res.json({
      configured: isConfigured,
      hasToken: Boolean(config.telegramToken),
      hasWebhookSecret: Boolean(config.webhookSecret),
      hasGeminiApiKey: Boolean(config.geminiApiKey),
      // WhatsApp Channel Status
      whatsappConfigured: isWaConfigured,
      hasWhatsAppToken: Boolean(config.whatsappAccessToken),
      hasWhatsAppPhoneId: Boolean(config.whatsappPhoneNumberId),
      hasWhatsAppVerifyToken: Boolean(config.whatsappVerifyToken),
      whatsappWebhookPath: '/whatsapp-webhook',
      fullWhatsAppWebhookUrl: config.appUrl ? `${config.appUrl}/whatsapp-webhook` : '/whatsapp-webhook',
      spreadsheetId: sheetsDb.getSpreadsheetId(),
      appUrl: config.appUrl,
      webhookPath: '/api/telegram-webhook',
      fullWebhookUrl: config.appUrl ? `${config.appUrl}/api/telegram-webhook` : 'APP_URL not set',
      stats,
      // Diagnostics log buffer
      recentWhatsAppLogs: (globalThis as any).__RECENT_WA_LOGS || [],
    });
  });

  // Direct WhatsApp test endpoint from browser or curl
  app.get('/api/whatsapp/test', async (req, res) => {
    const to = (req.query.to as string) || '';
    if (!to) {
      return res.status(400).json({ error: 'Please provide ?to=23480... query param' });
    }
    const result = await sendWhatsAppMessage(to, '🧪 Test message directly triggered from Floate AI Server Diagnostics!');
    res.json({
      success: result,
      recipient: to,
      logs: (globalThis as any).__RECENT_WA_LOGS || [],
    });
  });

  // 3. Google Sheets Database Endpoints
  app.get('/api/sheets/records', async (_req, res) => {
    try {
      const data = await sheetsDb.getRecentLogs();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to fetch sheet records' });
    }
  });

  app.post('/api/sheets/config', (req, res) => {
    const { spreadsheetId } = req.body;
    if (!spreadsheetId || typeof spreadsheetId !== 'string') {
      res.status(400).json({ error: 'spreadsheetId is required' });
      return;
    }
    sheetsDb.setSpreadsheetId(spreadsheetId);
    res.json({ success: true, spreadsheetId });
  });

  // 3b. Flutterwave Payment Gateway Webhook Endpoint
  app.post('/api/flutterwave-webhook', async (req, res) => {
    try {
      const { status, tx_ref, amount, customer, meta } = req.body?.data || req.body || {};
      const merchantId = meta?.merchantId || customer?.email || tx_ref?.split('_')?.[1];

      if (status === 'successful' && merchantId && amount) {
        const topupAmount = Number(amount);
        const result = await firestoreDb.topupMerchantWallet(String(merchantId), topupAmount, tx_ref || `flw_${Date.now()}`);

        res.json({
          status: 'success',
          merchantId,
          topupAmount,
          newBalance: result.newBalance,
          message: 'Merchant wallet successfully credited via Flutterwave webhook',
        });
        return;
      }

      res.status(400).json({ status: 'ignored', reason: 'Unsuccessful or missing payment parameters' });
    } catch (err: any) {
      console.error('[Flutterwave Webhook Error]:', err);
      res.status(500).json({ error: err?.message || 'Webhook processing failed' });
    }
  });

  // 3c. Merchant Wallet & Status API Endpoint
  app.get('/api/merchant/:id/wallet', async (req, res) => {
    try {
      const merchantId = req.params.id;
      const merchant = await firestoreDb.getMerchant(merchantId);
      if (!merchant) {
        res.status(404).json({ error: 'Merchant not found' });
        return;
      }
      res.json({
        merchantId: merchant.id,
        businessName: merchant.businessName,
        creditBalance: merchant.credit_balance,
        status: merchant.status,
        qualifiedLeadsRemaining: Math.floor(merchant.credit_balance / 200),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to fetch merchant wallet' });
    }
  });

  // Data Migration & Status Endpoint (Step 1: Google Sheets -> Firestore Migration)
  app.post('/api/data/migrate-sheets', async (_req, res) => {
    try {
      console.log('[API] /api/data/migrate-sheets invoked.');
      const result = await firestoreDb.migrateSheetsToFirestore();
      res.json(result);
    } catch (err: any) {
      console.error('[API /api/data/migrate-sheets Error]:', err);
      res.status(500).json({ success: false, error: err?.message || 'Migration failed' });
    }
  });

  app.get('/api/data/status', async (_req, res) => {
    try {
      const merchants = await firestoreDb.getActiveMerchants();
      const products = await firestoreDb.getProductsFromFirestore();
      res.json({
        primaryDatabase: 'Firestore',
        backupDatabase: 'Google Sheets (Passive)',
        totalActiveMerchants: merchants.length,
        totalProducts: products.length,
        sampleMerchants: merchants.slice(0, 5).map((m) => m.businessName),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to get data status' });
    }
  });

  // 4. Live Bot Simulator Endpoint (Test Bot Logic Programmatically)
  app.post('/api/bot/simulate', async (req, res) => {
    try {
      const { message, userId, phone, firstName, channel } = req.body;
      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Field "message" is required and must be a string' });
        return;
      }

      const activeUserId = phone || userId || '2348012345678';
      const activeChannel = channel || 'whatsapp';

      const result = await processSimulatedMessage(
        message,
        activeUserId,
        firstName || 'Customer',
        activeChannel
      );

      res.json(result);
    } catch (err: any) {
      console.error('[Simulate Error]:', err);
      res.status(500).json({ error: err?.message || 'Simulation failed' });
    }
  });

  // 4. Telegram Webhook Endpoint
  app.post('/api/telegram-webhook', (req, res, next) => {
    const activeToken = process.env.TELEGRAM_BOT_TOKEN || config.telegramToken;
    if (!activeToken || activeToken.includes('DummyToken')) {
      res.status(503).json({
        error: 'TELEGRAM_BOT_TOKEN environment variable is missing or invalid.',
      });
      return;
    }

    const updateId = req.body?.update_id;
    const msgText = req.body?.message?.text || req.body?.edited_message?.text || req.body?.callback_query?.data || '(non-text update)';
    const sender = req.body?.message?.from?.username || req.body?.message?.from?.first_name || 'unknown';

    console.log(`[Telegram Webhook Ingress] Update #${updateId} from ${sender}: "${msgText}"`);

    const currentBot = getBotInstance();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || config.webhookSecret;

    const cb = webhookCallback(currentBot, 'express', {
      secretToken: secret || undefined,
      onTimeout: 'return',
    });

    cb(req, res);
  });

  // 4b. Meta WhatsApp Cloud API Webhook Endpoints
  // GET: Challenge verification for Meta Developer Console
  app.get('/whatsapp-webhook', handleWhatsAppVerification);
  app.get('/api/whatsapp-webhook', handleWhatsAppVerification);

  // POST: Incoming messages, buttons, and voice notes from WhatsApp users
  app.post('/whatsapp-webhook', handleWhatsAppWebhook);
  app.post('/api/whatsapp-webhook', handleWhatsAppWebhook);

  // 5. Automatic Long Polling Runner
  const activeToken = process.env.TELEGRAM_BOT_TOKEN || config.telegramToken;
  if (activeToken && !activeToken.includes('DummyToken') && isBotConfigured()) {
    if (process.env.DISABLE_POLLING !== 'true' && process.env.USE_POLLING !== 'false') {
      try {
        const bot = getBotInstance();
        // Verify credentials with getMe before attempting start
        bot.api.getMe()
          .then(async (botInfo) => {
            console.log(`🤖 Telegram Token verified for @${botInfo.username}. Connecting in LONG POLLING mode...`);
            // Delete any existing webhook before starting long polling
            await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
            bot.start({
              allowed_updates: ['message', 'edited_message', 'callback_query'],
              onStart: (info) => {
                console.log(`✅ Telegram Bot live & listening on Telegram as @${info.username}`);
              },
            }).catch((err: any) => {
              const msg = err?.message || String(err);
              if (msg.includes('409') || msg.includes('Conflict') || msg.includes('getUpdates')) {
                console.warn('⚠️ Telegram Long Polling Conflict (409): Another instance or process is already active for this bot token.');
              } else if (msg.includes('401') || msg.includes('Unauthorized')) {
                console.warn('⚠️ Telegram Bot Token unauthorized (401). Polling paused. Please provide a valid TELEGRAM_BOT_TOKEN.');
              } else {
                console.warn('Telegram Long Polling notice:', msg);
              }
            });
          })
          .catch((err: any) => {
            const msg = err?.message || String(err);
            if (msg.includes('401') || msg.includes('Unauthorized')) {
              console.warn('⚠️ [Telegram Bot] Token is invalid or unauthorized (401). Long polling skipped. Please configure a valid TELEGRAM_BOT_TOKEN in Settings.');
            } else {
              console.warn('⚠️ [Telegram Bot] Token verification notice:', msg);
            }
          });
      } catch (err: any) {
        console.warn('Telegram Bot startup notice:', err?.message || err);
      }
    }
  }

  // 6. Automatic / Manual Webhook Setup Helper
  const handleSetWebhook = async (req: express.Request, res: express.Response) => {
    const activeToken = process.env.TELEGRAM_BOT_TOKEN || config.telegramToken;
    if (!activeToken || activeToken.includes('DummyToken')) {
      res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN environment variable is not configured.' });
      return;
    }

    const protocol = (req.headers['x-forwarded-proto'] as string) || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const detectedDomain = `${protocol}://${host}`;
    const targetBaseUrl = req.body?.appUrl || process.env.APP_URL || config.appUrl || detectedDomain;
    const webhookUrl = `${targetBaseUrl.replace(/\/$/, '')}/api/telegram-webhook`;

    try {
      const currentBot = getBotInstance();
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET || config.webhookSecret;

      const success = await currentBot.api.setWebhook(webhookUrl, {
        secret_token: secret || undefined,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      });

      res.json({
        success,
        webhookUrl,
        allowedUpdates: ['message', 'edited_message', 'callback_query'],
        botTokenProvided: true,
        secretTokenSet: Boolean(secret),
        message: `Successfully registered webhook with Telegram servers for all message types: ${webhookUrl}`,
      });
    } catch (err: any) {
      console.error('Failed to set Telegram webhook:', err);
      res.status(500).json({
        error: 'Failed to set webhook with Telegram API',
        details: err?.message || String(err),
      });
    }
  };

  app.post('/api/bot/set-webhook', handleSetWebhook);
  // Admin Merchant Deletion Endpoint
  app.post('/api/admin/delete-merchant', async (req, res) => {
    try {
      const { merchantId } = req.body || {};
      const target = merchantId || '2345';
      
      const sheetsDeleted = sheetsDb.deleteMerchantByQuery(target);
      const firestoreResult = await firestoreDb.deleteMerchant(target);

      return res.json({
        success: true,
        message: `Successfully deleted merchant "${target}" from database.`,
        details: {
          sheetsListingsDeleted: sheetsDeleted,
          firestoreMerchantDeleted: firestoreResult.deletedMerchant,
          firestoreProductsDeleted: firestoreResult.deletedProductsCount,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Failed to delete merchant' });
    }
  });

  // Auto-clean requested obsolete test merchants on startup
  setTimeout(async () => {
    // 1. Merchant 4562 & 2345
    sheetsDb.deleteMerchantByQuery('4562');
    sheetsDb.deleteMerchantByQuery('Merchant 4562');
    sheetsDb.deleteMerchantByQuery('2345');
    await firestoreDb.deleteMerchant('4562').catch(() => {});
    await firestoreDb.deleteMerchant('Merchant 4562').catch(() => {});
    await firestoreDb.deleteMerchant('2345').catch(() => {});

    // 2. Clean orphaned dummy seed-mbams (keeping real registered Mbams vendor)
    sheetsDb.deleteMerchantByQuery('seed-mbams');
    sheetsDb.deleteMerchantByQuery('08031234567');
    await firestoreDb.deleteMerchant('seed-mbams').catch(() => {});
    await firestoreDb.deleteMerchant('08031234567').catch(() => {});
  }, 1000);

  // Serve Frontend / Dashboard (Vite in dev, static files in prod)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Telegram Bot Logic Server running at http://0.0.0.0:${PORT}`);
  });
}

// Global process error handlers to prevent app crash on background network errors
process.on('unhandledRejection', (reason: any) => {
  const reasonStr = String(reason?.message || reason);
  if (
    reasonStr.includes('409') ||
    reasonStr.includes('Conflict') ||
    reasonStr.includes('getUpdates') ||
    reasonStr.includes('401') ||
    reasonStr.includes('Unauthorized') ||
    reasonStr.includes('getMe')
  ) {
    console.warn('⚠️ Process caught Telegram network notice:', reasonStr);
    return;
  }
  console.error('Unhandled Rejection at:', reason);
});

process.on('uncaughtException', (err: any) => {
  const errStr = String(err?.message || err);
  if (
    errStr.includes('409') ||
    errStr.includes('Conflict') ||
    errStr.includes('getUpdates') ||
    errStr.includes('401') ||
    errStr.includes('Unauthorized') ||
    errStr.includes('getMe')
  ) {
    console.warn('⚠️ Process caught Telegram uncaught notice:', errStr);
    return;
  }
  console.error('Uncaught Exception:', err);
});

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
