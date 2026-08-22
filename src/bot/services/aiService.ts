import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { withExternalTimeout } from './timeoutService.js';

let aiInstance: GoogleGenAI | null = null;

function getAIClient(): GoogleGenAI | null {
  const activeKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
  if (!activeKey) return null;
  return new GoogleGenAI({
    apiKey: activeKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Executes a Gemini generateContent request with automatic model fallbacks and an explicit 8-10s timeout.
 */
async function generateContentWithFallback(
  ai: GoogleGenAI,
  requestParams: Omit<Parameters<typeof ai.models.generateContent>[0], 'model'>,
  modelsToTry: string[] = ['gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest']
) {
  return withExternalTimeout(
    async () => {
      let lastError: any = null;
      for (const modelName of modelsToTry) {
        try {
          const response = await ai.models.generateContent({
            ...requestParams,
            model: modelName,
          });
          return response;
        } catch (err: any) {
          lastError = err;
          const errMsg = err?.message || String(err);
          console.log(`[Gemini AI Info] Model "${modelName}" status (${errMsg.slice(0, 80)}). Trying fallback model...`);
        }
      }
      throw lastError;
    },
    {
      timeoutMs: 8500,
      serviceName: 'Gemini',
      operationName: 'generateContentWithFallback',
    }
  );
}

export interface ParsedCommerceQuery {
  searchKeywords: string; // Clean product/item name, e.g. "Phone", "Laptop", "Lawyer", "Video Editor"
  maxPriceNaira?: number | null;
  buyerLocation?: string | null; // Buyer's location e.g. "Agbani"
  targetSellerLocation?: string | null; // Required seller location e.g. "Enugu", "Onitsha"
  category?: string | null; // Broader category e.g. "Electronics", "Footwear", "Legal Services"
  inferredCategories?: string[]; // Tightly-related categories/services inferred by AI, e.g. ["Legal Services", "Legal Consultation", "Attorney", "Law Firm"]
  itemType?: 'product' | 'service'; // Gemini's judgment on whether the item is a product or service
  isRegistrationRequest?: boolean;
  friendlyAck?: string;
}

export type InboundIntentType =
  | 'RESET_OR_HOME'
  | 'GREETING'
  | 'SMALL_TALK'
  | 'HELP_OR_SUPPORT'
  | 'BRAND_QUESTION'
  | 'LOCATION_CHANGE'
  | 'REPORT_VENDOR'
  | 'MERCHANT_ADD_PRODUCT'
  | 'MERCHANT_EDIT_CATALOG'
  | 'MERCHANT_STATS'
  | 'MERCHANT_PORTAL'
  | 'BROWSE_MARKETS'
  | 'BUYER_SEARCH';

export interface InboundClassificationResult {
  intent: InboundIntentType;
  confidence: number;
  extractedQuery?: ParsedCommerceQuery;
  extractedLocation?: string | null;
  rawText: string;
}

/**
 * High-precision intent classifier combining fast regex routing and Gemini commerce parsing
 */
export async function classifyInboundIntent(rawInput: string): Promise<InboundClassificationResult> {
  const text = (rawInput || '').trim();
  const lower = text.toLowerCase().replace(/[^a-z0-9 _]+/g, '').replace(/\s+/g, ' ');

  // 1. Reset / Home
  if (/^(reset|cancel|stop|exit|start over|restart|home|menu|main menu|\/start|\/cancel|btn_home)$/i.test(lower)) {
    return { intent: 'RESET_OR_HOME', confidence: 1.0, rawText: text };
  }

  // 2. Greeting
  if (/^(hi|hi floate|hello|hello floate|hey|hey floate|good morning|good afternoon|good evening|start)$/i.test(lower)) {
    return { intent: 'GREETING', confidence: 0.98, rawText: text };
  }

  // 3. Brand Questions (e.g., "what is floate about", "who made floate", "what do you do", "tell me about floate")
  if (
    /\b(what\s+is\s+floate|about\s+floate|who\s+made\s+floate|who\s+owns\s+floate|floate\s+about|what\s+does\s+floate\s+do|tell\s+me\s+about\s+floate|how\s+does\s+floate\s+work|what\s+is\s+this\s+bot|who\s+are\s+you)\b/i.test(
      lower
    ) ||
    /^(what is floate|about floate|tell me about floate|who is floate|what does floate do|what can floate do|who created floate|who are you)$/i.test(
      lower
    )
  ) {
    return { intent: 'BRAND_QUESTION', confidence: 0.96, rawText: text };
  }

  // 4. Small Talk / Casual Conversational Check-ins
  if (
    /^(how are you|how are you doing|how far|how body|how are you today|how things|how is your day|how you dey|how you doing|what's up|whats up|sup|how's it going|hows it going)$/i.test(
      lower
    )
  ) {
    return { intent: 'SMALL_TALK', confidence: 0.95, rawText: text };
  }

  // 5. Help / Support
  if (/^(help|how does this work|how it works|how do i use this|support|customer care|contact support|what can you do)$/i.test(lower)) {
    return { intent: 'HELP_OR_SUPPORT', confidence: 0.95, rawText: text };
  }

  // 5. Location Change
  const locChangeMatch = lower.match(/^(?:change|update|set|switch)\s+(?:my\s+)?(?:location|city)(?:\s+to\s+(.+))?$/i);
  if (locChangeMatch || /^(my location|change location|update location|switch location)$/i.test(lower)) {
    const inlineLoc = locChangeMatch && locChangeMatch[1] ? locChangeMatch[1].trim() : null;
    return { intent: 'LOCATION_CHANGE', confidence: 0.95, extractedLocation: inlineLoc, rawText: text };
  }

  // 6. Report / Scam
  if (text.startsWith('report_vendor_') || text === 'btn_report_vendor' || /^(report|report vendor|report seller|scam|fraud|fake receipt)$/i.test(lower)) {
    return { intent: 'REPORT_VENDOR', confidence: 0.95, rawText: text };
  }

  // 7. Merchant Direct Actions
  if (
    text === 'btn_vendor_add_product' ||
    /\b(add\s+(a\s+)?(new\s+)?(product|item|listing|stock)|upload\s+(a\s+)?(new\s+)?(product|item)|list\s+(a\s+)?(new\s+)?(product|item))\b/i.test(lower) ||
    /^(add product|addproduct|add item|new product|list product|upload product|add a product|post product)$/i.test(lower)
  ) {
    return { intent: 'MERCHANT_ADD_PRODUCT', confidence: 0.95, rawText: text };
  }

  if (
    text === 'btn_vendor_edit_products' ||
    /\b(edit\s+(my\s+)?(product|products|item|items|listing|listings|prices|catalog|store)|modify\s+(my\s+)?(product|products)|update\s+(my\s+)?(product|products|prices)|manage\s+(my\s+)?(products|inventory))\b/i.test(lower) ||
    /^(edit product|edit products|editproduct|edit listings|my inventory|inventory|manage products|edit prices|update product)$/i.test(lower)
  ) {
    return { intent: 'MERCHANT_EDIT_CATALOG', confidence: 0.95, rawText: text };
  }

  if (
    text === 'btn_vendor_stats' ||
    /\b(my\s+stats|store\s+stats|business\s+stats|how\s+many\s+searches|view\s+stats|shop\s+performance|business\s+performance|my\s+analytics)\b/i.test(lower) ||
    /^(stats|view stats|performance|my stats|mystats|my business stats|business stats|store stats|analytics)$/i.test(lower)
  ) {
    return { intent: 'MERCHANT_STATS', confidence: 0.95, rawText: text };
  }

  if (
    text === 'START_REGISTER_VENDOR' ||
    text === 'btn_for_businesses' ||
    text === 'btn_vendor_portal' ||
    text === 'btn_vendor_dashboard' ||
    /\b(register\s+(my\s+)?(business|store|shop|account|company)|i\s+want\s+to\s+(register|sell|start\s+selling|list\s+my\s+shop)|become\s+a\s+(seller|vendor|merchant)|sell\s+on\s+floate|merchant\s+registration|vendor\s+registration)\b/i.test(lower) ||
    /^(register|register business|register my business|register shop|start selling|sell|vendor registration|merchant registration|open shop|add my shop|list my shop|vendor|business|vendor hub|merchant|my business|vendor portal|manage|merchant portal|dashboard|my store|store)$/i.test(lower)
  ) {
    return { intent: 'MERCHANT_PORTAL', confidence: 0.95, rawText: text };
  }

  // 8. Browse Markets
  if (text === 'btn_browse_markets' || /^(browse markets|markets|view markets|market hub)$/i.test(lower)) {
    return { intent: 'BROWSE_MARKETS', confidence: 0.95, rawText: text };
  }

  // 9. Default to Buyer Commerce Search
  const parsed = await parseShoppingQuery(text);
  if (parsed.isRegistrationRequest) {
    return { intent: 'MERCHANT_PORTAL', confidence: 0.9, extractedQuery: parsed, rawText: text };
  }

  return {
    intent: 'BUYER_SEARCH',
    confidence: 0.92,
    extractedQuery: parsed,
    extractedLocation: parsed.targetSellerLocation,
    rawText: text,
  };
}

/**
 * Formats user search parameters into a clean confirmation header.
 * Example: "Got it, connecting you to a verified seller/business for Phone, around ₦200,000."
 */
export function formatSearchConfirmation(cleanProduct: string, maxPriceNaira?: number | null, targetSellerLocation?: string | null): string {
  const item = cleanProduct ? cleanProduct.trim().charAt(0).toUpperCase() + cleanProduct.trim().slice(1) : 'Item';
  let text = `Got it, connecting you to a verified seller/business for ${item}`;
  if (maxPriceNaira) {
    text += `, around ₦${maxPriceNaira.toLocaleString()}`;
  }
  if (targetSellerLocation) {
    text += `, in ${targetSellerLocation}`;
  }
  return text + '.';
}

/**
 * Transcribes voice messages in English, Nigerian Pidgin, Yoruba, Igbo, and extracts commerce details.
 */
export async function transcribeAndAnalyzeAudio(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<{ transcript: string; analysis: string; parsedQuery?: ParsedCommerceQuery }> {
  const ai = getAIClient();
  if (!ai) {
    console.error('[Voice AI Error] Gemini API key not configured or AI client unavailable.');
    return {
      transcript: "",
      analysis: "Gemini API key not configured for voice processing.",
    };
  }

  try {
    console.log(`[Voice AI] Transcribing audio buffer: size=${audioBuffer.length} bytes, mimeType="${mimeType}"`);
    const base64Audio = audioBuffer.toString('base64');
    
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio,
          },
        },
        {
          text: `You are Floate AI's AI voice assistant for African & Nigerian commerce.
Transcribe this audio accurately. The speaker may use English, Nigerian Pidgin, Yoruba, or Igbo.
Analyze the natural language in the voice note to extract core search keywords, location, budget, and inferred business categories.

Provide output strictly in JSON format:
{
  "transcript": "Full, exact transcription of what the buyer said in the voice note",
  "cleanProduct": "Clean main product or item name being searched (e.g., Handbag, Leather Slippers, Lawyer, Video Editor, Generator) - strip conversational noise like 'I want to buy', 'where can I get'",
  "maxPriceNaira": 5000 (number or null, parsed budget e.g., 5k -> 5000, 50k -> 50000, 20k -> 20000),
  "location": "City, State or Market location mentioned e.g., Lagos, Onitsha, Enugu, Abuja, Ikeja or null",
  "category": "Broad product category e.g., Footwear, Clothing, Legal Services, Media & Production, Phones & Accessories, Electronics or null",
  "inferredCategories": ["Legal Services", "Legal Consultation", "Lawyer", "Attorney"] (array of 3-6 tight synonym or category terms for business matching),
  "itemType": "service" (either "product" or "service"),
  "friendlyAck": "A warm 1-sentence response in natural Nigerian Pidgin or English confirming what you are searching for"
}
Return ONLY valid JSON.`,
        },
      ],
    });

    const text = response.text || '';
    console.log('[Voice AI] Gemini API raw response text received:', text);

    let transcriptText = '';
    let cleanKeywords = '';
    let parsedPrice: number | null = null;
    let parsedLoc: string | null = null;
    let parsedCategory: string | null = null;
    let parsedInferred: string[] = [];
    let parsedItemType: 'product' | 'service' | undefined = undefined;
    let friendlyAck = '';

    try {
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      transcriptText = parsed.transcript || text;
      cleanKeywords = parsed.cleanProduct || parsed.searchKeywords || parsed.product || '';
      parsedPrice = typeof parsed.maxPriceNaira === 'number' ? parsed.maxPriceNaira : (typeof parsed.maxPrice === 'number' ? parsed.maxPrice : null);
      parsedLoc = parsed.location || parsed.targetSellerLocation || null;
      parsedCategory = parsed.category || null;
      parsedInferred = Array.isArray(parsed.inferredCategories) ? parsed.inferredCategories.filter((c: any) => typeof c === 'string') : [];
      if (parsed.itemType === 'service' || parsed.itemType === 'product') {
        parsedItemType = parsed.itemType;
      }
      friendlyAck = parsed.friendlyAck || '';
      console.log(`[Voice AI] Successfully parsed voice JSON: transcript="${transcriptText}", keywords="${cleanKeywords}", price=${parsedPrice}, loc="${parsedLoc}", itemType="${parsedItemType}", inferred=${JSON.stringify(parsedInferred)}`);
    } catch (jsonErr: any) {
      console.warn('[Voice AI Warning] Could not parse Gemini response as JSON, falling back to raw text. Error:', jsonErr?.message || jsonErr);
      transcriptText = text.trim();
    }

    // Secondary fallback parse on transcript text if cleanKeywords were not extracted in JSON step
    let finalParsedQuery: ParsedCommerceQuery | undefined;
    if (transcriptText && transcriptText.length > 2) {
      if (cleanKeywords) {
        finalParsedQuery = {
          searchKeywords: cleanKeywords,
          maxPriceNaira: parsedPrice,
          targetSellerLocation: parsedLoc,
          category: parsedCategory,
          inferredCategories: parsedInferred.length > 0 ? parsedInferred : [cleanKeywords, ...(parsedCategory ? [parsedCategory] : [])],
          itemType: parsedItemType,
          friendlyAck: friendlyAck,
        };
      } else {
        // Run shopping query parser on transcribed text
        console.log('[Voice AI] Running secondary text parser on transcribed audio:', transcriptText);
        finalParsedQuery = await parseShoppingQuery(transcriptText);
      }
    }

    return {
      transcript: transcriptText,
      analysis: friendlyAck || 'Searching Floate AI sellers network...',
      parsedQuery: finalParsedQuery,
    };
  } catch (error: any) {
    console.error('[Voice AI Critical Error] Audio transcription API call failed:', error?.stack || error?.message || error);
    return {
      transcript: "",
      analysis: `Voice note processing failed. Error: ${error?.message || String(error)}`,
    };
  }
}

// In-memory LRU-style cache for AI search query parsing
const queryParseCache = new Map<string, { data: ParsedCommerceQuery; timestamp: number }>();
const QUERY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Parses natural language shopping queries (English, Pidgin, Yoruba, Igbo) into structured search parameters using Gemini API.
 */
export async function parseShoppingQuery(userQuery: string): Promise<ParsedCommerceQuery> {
  const normKey = (userQuery || '').toLowerCase().trim();
  if (!normKey) return fallbackQueryParse(userQuery);

  // Check cache first
  const cached = queryParseCache.get(normKey);
  if (cached && Date.now() - cached.timestamp < QUERY_CACHE_TTL_MS) {
    return cached.data;
  }

  const ai = getAIClient();
  if (!ai) {
    const fallback = fallbackQueryParse(userQuery);
    queryParseCache.set(normKey, { data: fallback, timestamp: Date.now() });
    return fallback;
  }

  const queryTask = (async () => {
    try {
      const response = await generateContentWithFallback(ai, {
        contents: `Analyze this message for Floate AI (African/Nigerian commerce platform).
The user message may be in English, Nigerian Pidgin, Yoruba, or Igbo.

User message: "${userQuery}"

Task: Extract structured commerce details:
1. "cleanProduct": The clean main product or service name ONLY (e.g. "Phone", "Laptop", "Lawyer", "Video Editor", "Leather Slippers"). Strip out conversational noise like "I want to buy", "I need a", "looking for someone to".
2. "maxPriceNaira": Maximum budget in Nigerian Naira as a number (e.g., "200k" -> 200000, "5k" -> 5000, "1.5m" -> 1500000). Return null if no budget mentioned.
3. "buyerLocation": The BUYER's own location if mentioned (e.g. "my location is Agbani", "I stay in Agbani" -> "Agbani").
4. "targetSellerLocation": The required SELLER location (State, City, or Market Area) if user mentioned a seller location or location preference (e.g., "seller in Enugu", "in Onitsha", "from Lagos", "in Agbani", "in Imo"). If user only gave their own location, set targetSellerLocation to null.
5. "category": Broad product or service category (e.g. "Phones & Accessories", "Computers", "Legal Services", "Media & Video Production", "Footwear", "Clothing").
6. "inferredCategories": An array of 3 to 6 tightly-related business category names, service types, or synonym terms that represent businesses capable of fulfilling this request.
   Examples:
   - "I need a lawyer" -> ["Legal Services", "Legal Consultation", "Attorney", "Law Firm", "Lawyer", "Legal Advocate"]
   - "someone to edit my videos" -> ["Video Editor", "Video Editing Services", "Videographer", "Media Production", "Content Creation"]
   - "car mechanic" -> ["Auto Repair", "Car Mechanic", "Automobile Repairs", "Auto Mechanic"]
   - "catering for wedding" -> ["Catering Services", "Caterer", "Event Catering", "Food Services"]
   - "leather slippers" -> ["Footwear", "Leather Slippers", "Shoes", "Plaited Slippers", "Sandals"]
   Do NOT include vague/overly broad words like "Business", "Services", "Shop", "General", "Other".
7. "itemType": Either "product" or "service". Determine whether the clean item requested represents a physical product (e.g. "Phone", "Cloth", "Shoes", "Generator") or a service/profession to be hired or booked (e.g. "Lawyer", "Video Editor", "Mechanic", "Catering", "Graphic Designer", "Tutor", "Consultant", "Photographer").
8. "isRegistrationRequest": true ONLY if user wants to register as a business/seller.

Return ONLY valid JSON format like:
{
  "cleanProduct": "Lawyer",
  "maxPriceNaira": null,
  "buyerLocation": null,
  "targetSellerLocation": "Onitsha",
  "category": "Legal Services",
  "inferredCategories": ["Legal Services", "Legal Consultation", "Attorney", "Law Firm", "Lawyer"],
  "itemType": "service",
  "isRegistrationRequest": false
}`,
      });

      const text = response.text || '';
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const json = JSON.parse(cleanJson);

      const inferredCats: string[] = Array.isArray(json.inferredCategories)
        ? json.inferredCategories.filter((c: any) => typeof c === 'string' && c.trim().length > 0)
        : [];

      const parsedItemType: 'product' | 'service' = json.itemType === 'service' ? 'service' : 'product';

      return {
        searchKeywords: json.cleanProduct || userQuery,
        maxPriceNaira: typeof json.maxPriceNaira === 'number' ? json.maxPriceNaira : null,
        buyerLocation: json.buyerLocation || null,
        targetSellerLocation: json.targetSellerLocation || null,
        category: json.category || null,
        inferredCategories: inferredCats.length > 0 ? inferredCats : [json.cleanProduct || userQuery, ...(json.category ? [json.category] : [])],
        itemType: parsedItemType,
        isRegistrationRequest: Boolean(json.isRegistrationRequest),
        friendlyAck: `Connecting you to a verified seller for ${json.cleanProduct || 'items'}...`,
      };
    } catch (err) {
      console.warn('AI query parsing notice, using fallback:', err);
      return fallbackQueryParse(userQuery);
    }
  })();

  // Guarantee 8-10 second response time
  const result = await withExternalTimeout(
    () => queryTask,
    {
      timeoutMs: 8500,
      serviceName: 'Gemini',
      operationName: 'parseShoppingQuery',
      fallbackValue: fallbackQueryParse(userQuery),
    }
  );
  queryParseCache.set(normKey, { data: result, timestamp: Date.now() });
  return result;
}

function fallbackQueryParse(query: string): ParsedCommerceQuery {
  let maxPriceNaira: number | null = null;
  const priceMatch = query.match(/(?:₦|naira|ngn)?\s*(\d+(?:\.\d+)?)\s*(k|kobo|m|naira|ngn)?/i);
  if (priceMatch) {
    const val = parseFloat(priceMatch[1]);
    const unit = (priceMatch[2] || '').toLowerCase();
    if (unit === 'k') maxPriceNaira = val * 1000;
    else if (unit === 'm') maxPriceNaira = val * 1000000;
    else if (val > 100) maxPriceNaira = val;
  }

  // Extract location if mentioned (e.g. "in Onitsha", "at Aba", "Enugu")
  const knownLocations = [
    'Onitsha', 'Enugu', 'Lagos', 'Abuja', 'Imo', 'Owerri', 'Abia', 'Aba',
    'Rivers', 'Port Harcourt', 'Kano', 'Oyo', 'Ibadan', 'Delta', 'Asaba',
    'Edo', 'Benin', 'Ebonyi', 'Abakaliki', 'Anambra', 'Awka', 'Uyo', 'Calabar'
  ];

  let targetSellerLocation: string | null = null;
  for (const loc of knownLocations) {
    if (new RegExp(`\\b${loc}\\b`, 'i').test(query)) {
      targetSellerLocation = loc;
      break;
    }
  }

  // Extract simple clean product by stripping budget & location phrases
  let cleanProduct = query
    .replace(/i want to buy/gi, '')
    .replace(/where can i (?:find|buy|get)/gi, '')
    .replace(/looking for/gi, '')
    .replace(/i am looking for/gi, '')
    .replace(/i need/gi, '')
    .replace(/i want/gi, '')
    .replace(/my location is [a-z0-9\s]+/gi, '')
    .replace(/i stay in [a-z0-9\s]+/gi, '')
    .replace(/(?:₦|naira|ngn)?\s*\d+\s*(k|m|naira|ngn)?/gi, '')
    .replace(/around/gi, '')
    .replace(/for/gi, '')
    .replace(/of/gi, '')
    .replace(/in\s+[a-z\s]+/gi, '')
    .replace(/at\s+[a-z\s]+/gi, '')
    .replace(/,/g, '')
    .trim();

  if (!cleanProduct) cleanProduct = query;

  // Infer category hint & inferred categories list
  let category: string | null = null;
  const inferredCategories: string[] = [cleanProduct];
  const lowerProduct = cleanProduct.toLowerCase();

  if (/lawyer|attorney|legal/i.test(lowerProduct)) {
    category = 'Legal Services';
    inferredCategories.push('Legal Services', 'Legal Consultation', 'Lawyer', 'Attorney', 'Law Firm');
  } else if (/edit|video|videographer/i.test(lowerProduct)) {
    category = 'Media & Production';
    inferredCategories.push('Video Editor', 'Video Editing Services', 'Videographer', 'Media Production');
  } else if (/mechanic|repair car|auto/i.test(lowerProduct)) {
    category = 'Automotive Services';
    inferredCategories.push('Auto Repair', 'Car Mechanic', 'Automobile Repairs', 'Mechanic');
  } else if (/cater|food|cook/i.test(lowerProduct)) {
    category = 'Catering';
    inferredCategories.push('Catering Services', 'Caterer', 'Event Catering', 'Food Services');
  } else if (/footwear|slipper|shoe|sandal|slide/i.test(lowerProduct)) {
    category = 'Footwear';
    inferredCategories.push('Footwear', 'Shoes', 'Slippers', 'Sandals');
  } else if (/phone|iphone|samsung|gadget/i.test(lowerProduct)) {
    category = 'Phones & Accessories';
    inferredCategories.push('Phones & Accessories', 'Smartphones', 'Gadgets');
  } else if (/laptop|computer|macbook|pc/i.test(lowerProduct)) {
    category = 'Computing';
    inferredCategories.push('Computers', 'Laptops', 'PC & Accessories');
  } else if (/gown|shirt|dress|fashion|cloth/i.test(lowerProduct)) {
    category = 'Fashion';
    inferredCategories.push('Fashion', 'Clothing', 'Apparel');
  }

  if (category && !inferredCategories.includes(category)) {
    inferredCategories.push(category);
  }

  const isReg = /register|list my|start business|seller account/i.test(query);

  let itemType: 'product' | 'service' = 'product';
  if (/lawyer|attorney|legal|edit|video|videographer|mechanic|repair|cater|consult|teach|tutor|design|photo|clean|laundry|hair|barber|makeup|doctor|nurse|accountant|plumb|electric|driver|tailor|service|gig/i.test(lowerProduct) ||
      /services|consultation|production|catering|repair/i.test(category || '')) {
    itemType = 'service';
  }

  return {
    searchKeywords: cleanProduct,
    maxPriceNaira,
    buyerLocation: null,
    targetSellerLocation,
    category,
    inferredCategories,
    itemType,
    isRegistrationRequest: isReg,
    friendlyAck: `Searching Floate AI sellers for "${cleanProduct}"...`,
  };
}

export async function generateAiReply(userPrompt: string, systemPrompt?: string): Promise<string> {
  const ai = getAIClient();
  if (!ai) {
    return "👋 Floate AI is currently processing your request.";
  }

  const defaultSystemPrompt = `You are Floate AI, an intelligent African commerce assistant headquartered in Nigeria.
Your mission is to connect buyers with sellers and local businesses directly across Nigerian cities (Lagos, Onitsha, Abuja, Port Harcourt, Ibadan, Kano, Aba, and across Nigeria).
Key guidelines:
• Never mention technical terms like "database", "spreadsheet", "google sheets", "table", or "system logs".
• Always speak in a warm, fair, welcoming, and helpful tone (standard Nigerian English or natural light Pidgin).
• Avoid using hyphens or dashes; use proper punctuation like commas and periods instead.
• Reference prices in Nigerian Naira (₦ or k).
• Emphasize direct connections between sellers and buyers.`;

  const replyTask = (async () => {
    try {
      const response = await generateContentWithFallback(ai, {
        contents: userPrompt,
        config: { systemInstruction: systemPrompt || defaultSystemPrompt },
      });

      return response.text || "No response generated by AI.";
    } catch (error: any) {
      console.error("Gemini AI API error in Telegram bot:", error);
      return `Looking up sellers across Nigeria...`;
    }
  })();

  return withExternalTimeout(
    () => replyTask,
    {
      timeoutMs: 8500,
      serviceName: 'Gemini',
      operationName: 'generateNaturalWelcome',
      fallbackValue: "Looking up sellers across Nigeria...",
    }
  );
}

/**
 * Parses numeric price from a string like "₦10,000", "200k", "₦ 15,000", "12000" to Naira integer
 */
export function parsePriceToNaira(priceStr: string): number | null {
  if (!priceStr) return null;
  const clean = priceStr.toLowerCase().replace(/,/g, '');
  const match = clean.match(/(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?/);
  if (!match) return null;
  let val = parseFloat(match[1]);
  if (isNaN(val) || val <= 0) return null;
  const unit = match[2];
  if (unit === 'k' || unit === 'thousand') val *= 1000;
  else if (unit === 'm' || unit === 'million') val *= 1000000;
  return Math.round(val);
}

/**
 * Generates an AI negotiation suggestion for a buyer when seller's item is marked Negotiable.
 * Strictly enforces a 5% to 10% discount range in code to protect seller profitability.
 */
export async function generateNegotiationSuggestion(
  productName: string,
  priceStr: string
): Promise<string | null> {
  const priceNaira = parsePriceToNaira(priceStr);
  if (!priceNaira || priceNaira < 100) {
    // Non-numeric price fallback
    return `💡 *Negotiation Tip:* This price is negotiable. You can politely ask the seller for a small discount for immediate purchase.`;
  }

  // Calculate 5% to 10% discount cap strictly in code
  const minOffer = Math.round(priceNaira * 0.90); // 10% off (maximum discount allowed)
  const maxOffer = Math.round(priceNaira * 0.95); // 5% off (minimum discount allowed)

  const minFormatted = `₦${minOffer.toLocaleString()}`;
  const maxFormatted = `₦${maxOffer.toLocaleString()}`;

  // Default code-enforced suggestion used as fallback or if AI output violates the 5-10% cap
  const codeEnforcedSuggestion = `💡 *Negotiation Tip:* You can open negotiations on WhatsApp with: "Hi! Would you consider between ${minFormatted} and ${maxFormatted} for a quick purchase?"`;

  const ai = getAIClient();
  if (!ai) {
    return codeEnforcedSuggestion;
  }

  try {
    const prompt = `You are Floate AI's commerce assistant guiding a buyer on WhatsApp.
The seller lists "${productName}" at "${priceStr}" (Naira value: ₦${priceNaira.toLocaleString()}) and set the price as negotiable.

Write a short, natural, low-pressure 1-sentence opening line for the buyer to propose a reasonable price to the seller.
STRICT CONSTRAINT: Your proposed price MUST fall strictly between ${minFormatted} and ${maxFormatted} (which is 5% to 10% off the list price). NEVER suggest any price lower than ${minFormatted}.

Return ONLY the single sentence response. Example:
"Hi! I am interested in ${productName}. Would you be open to ${maxFormatted} for a fast deal?"`;

    const response = await generateContentWithFallback(ai, {
      contents: prompt,
    }).catch(() => null);

    let text = response?.text?.trim() || '';
    if (!text) return codeEnforcedSuggestion;

    // Clean Markdown / quotes
    text = text.replace(/^["']|["']$/g, '').trim();

    // STRICT CODE ENFORCEMENT:
    // Check if the AI generated any price that is deeper than 10% off (below minOffer)
    const matches = text.matchAll(/(?:₦|naira|ngn)?\s*(\d[\d,.]*)\s*(k|m|thousand|million)?/gi);
    let violatesDiscountCap = false;
    for (const match of matches) {
      const p = parsePriceToNaira(match[0]);
      if (p && p > 0 && p < minOffer) {
        // Price suggested by Gemini is lower than 10% off! Violates seller protection rule!
        violatesDiscountCap = true;
        break;
      }
    }

    if (violatesDiscountCap) {
      // Reject AI text and use code-enforced exact bound suggestion
      return codeEnforcedSuggestion;
    }

    if (!text.startsWith('💡')) {
      text = `💡 *Negotiation Tip:* ${text}`;
    }

    return text;
  } catch (err) {
    return codeEnforcedSuggestion;
  }
}

export interface ExtractedInventoryData {
  product: string;
  price: string;
  numericPrice: number;
  category: string;
  quantity: number;
  specs: string;
  state?: string;
  city?: string;
  negotiable: 'Yes' | 'No';
  summaryText: string;
}

/**
 * AI Inventory Sync: Parses natural language merchant voice notes, text messages, or photo captions
 * to extract structured inventory details (Product, Price, Category, Specs, Location, Quantity).
 */
export async function extractInventoryFromVoiceOrPhoto(
  inputContent: string
): Promise<ExtractedInventoryData> {
  const fallbackPrice = parsePriceToNaira(inputContent) || 0;
  const fallbackPriceStr = fallbackPrice > 0 ? `₦${fallbackPrice.toLocaleString()}` : 'Contact for Price';

  const defaultResult: ExtractedInventoryData = {
    product: inputContent.slice(0, 60) || 'General Merchandise',
    price: fallbackPriceStr,
    numericPrice: fallbackPrice,
    category: 'General Goods',
    quantity: 1,
    specs: 'Standard Stock',
    negotiable: 'Yes',
    summaryText: inputContent,
  };

  const ai = getAIClient();
  if (!ai) return defaultResult;

  try {
    const prompt = `You are Floate AI's smart inventory parser for West African B2B merchants.
A merchant sent this voice transcript, photo caption, or message about their stock:
"${inputContent}"

Extract the stock listing details into a strictly valid JSON object with these keys:
{
  "product": "Specific item or product name (e.g. Nike Air Jordans, Smart Watch T800, Italian Leather Slippers)",
  "price": "Formatted price string with Naira symbol e.g. ₦35,000 or ₦5,000",
  "numericPrice": Number value in Naira e.g. 35000 or 5000 (0 if unknown),
  "category": "Inferred commercial category e.g. Footwear, Phones & Accessories, Fashion, Electronics, Computing",
  "quantity": Estimated integer quantity available e.g. 50 (default 1 if not stated),
  "specs": "Any extracted sizes, colors, brands, or notes e.g. Sizes 41-45, Black & White, Original",
  "state": "Nigerian state if mentioned (e.g. Abuja, Lagos, Anambra) or null",
  "city": "City or specific market location if mentioned (e.g. Wuse Market, Computer Village, Main Market) or null",
  "negotiable": "Yes" or "No" (default "Yes")
}

Return ONLY the plain JSON string, with no markdown formatting or commentary.`;

    const response = await generateContentWithFallback(ai, { contents: prompt }).catch(() => null);

    const jsonText = response?.text?.trim() || '';
    if (!jsonText) return defaultResult;

    const cleanJson = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    const numPrice = typeof parsed.numericPrice === 'number' && parsed.numericPrice > 0
      ? parsed.numericPrice
      : parsePriceToNaira(parsed.price) || fallbackPrice;

    const formattedPrice = numPrice > 0 ? `₦${numPrice.toLocaleString()}` : (parsed.price || fallbackPriceStr);

    return {
      product: parsed.product || defaultResult.product,
      price: formattedPrice,
      numericPrice: numPrice,
      category: parsed.category || defaultResult.category,
      quantity: typeof parsed.quantity === 'number' ? parsed.quantity : 1,
      specs: parsed.specs || 'Available in stock',
      state: parsed.state || undefined,
      city: parsed.city || undefined,
      negotiable: parsed.negotiable === 'No' ? 'No' : 'Yes',
      summaryText: `${parsed.product || defaultResult.product} at ${formattedPrice} (${parsed.specs || 'In Stock'})`,
    };
  } catch (err) {
    console.warn('[AI Inventory Extractor] Falling back to default parser:', err);
    return defaultResult;
  }
}

export interface SelfieValidationResult {
  isValid: boolean;
  isAiGenerated: boolean;
  hasSingleHumanFace: boolean;
  isCloseUpHeadshot: boolean;
  reason: string;
  userGuidance: string;
}

/**
 * Validates a submitted verification image using Gemini Vision multimodal analysis.
 * Accepts any real, genuine photograph of a single human face (selfies, portraits, normal phone camera shots).
 * Rejects AI-generated avatars, cartoon/digital art, group pictures with multiple people,
 * distant full-body shots with tiny faces, and product/unrelated images.
 */
export async function validateSelfieWithGeminiVision(
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg'
): Promise<SelfieValidationResult> {
  const ai = getAIClient();
  if (!ai) {
    // Graceful fallback if AI is not configured
    return {
      isValid: true,
      isAiGenerated: false,
      hasSingleHumanFace: true,
      isCloseUpHeadshot: true,
      reason: 'AI service unconfigured; marked for manual verification queue.',
      userGuidance: '',
    };
  }

  try {
    const base64Data = imageBuffer.toString('base64');
    const prompt = `You are the Floate AI Merchant Identity & Verification Assistant.
Analyze this submitted verification photo to confirm it is a genuine photograph of a real person (merchant identity verification).

VALIDATION CRITERIA:

ACCEPT (isValid = true):
- Any genuine photograph of a single real person where their face is visible and recognizable.
- Standard smartphone selfies, front or rear camera photos, chest-up / upper-body portraits, or photos of a person sitting in their shop, office, home, or vehicle.
- Normal, everyday phone camera conditions: standard lighting, natural indoor/outdoor light, mild shadows, slight angles, neutral expressions or smiles.
- Normal personal accessories: prescription glasses, headwraps, caps, hijabs, or modest makeup.

REJECT ONLY (isValid = false):
1. AI-generated faces, digital avatars, cartoons, CGI, illustrations, or synthetic deepfakes (Midjourney, DALL-E, etc.).
2. Group photos or crowd scenes showing multiple people where the primary individual cannot be uniquely identified.
3. Distant full-body shots where the person is far in the background and the face is too tiny or blurred to be recognized.
4. Product photos (shoes, electronics, bags), receipts, documents, store signs, cars, pets, memes, screenshots, or images with NO human face.
5. Photos where the face is completely covered or masked (e.g. balaclava, dark full-face motorcycle visor, completely blocked by hands or objects).

Output format: Return ONLY a raw JSON object with no markdown fences, matching this schema:
{
  "isValid": true | false,
  "isAiGenerated": true | false,
  "hasSingleHumanFace": true | false,
  "isCloseUpHeadshot": true | false,
  "reason": "Brief technical explanation of the evaluation",
  "userGuidance": "A warm, friendly, encouraging 1-2 sentence message to the business owner explaining what to adjust if rejected"
}`;

    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            { text: prompt },
          ],
        },
      ],
    }).catch(() => null);

    const responseText = response?.text?.trim() || '';
    if (!responseText) {
      return {
        isValid: false,
        isAiGenerated: false,
        hasSingleHumanFace: false,
        isCloseUpHeadshot: false,
        reason: 'No response received from vision model.',
        userGuidance: "Thanks for sending that! Unfortunately, this doesn't quite look like a clear selfie of your face. Could you send a new close-up photo? Takes just 2 seconds!",
      };
    }

    const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      isValid: Boolean(parsed.isValid),
      isAiGenerated: Boolean(parsed.isAiGenerated),
      hasSingleHumanFace: Boolean(parsed.hasSingleHumanFace),
      isCloseUpHeadshot: Boolean(parsed.isCloseUpHeadshot ?? parsed.isValid),
      reason: parsed.reason || 'Verification image analyzed.',
      userGuidance: parsed.userGuidance || "Thanks for sending that! Unfortunately, this doesn't quite look like a clear selfie of your face. Could you send a new photo showing your face clearly? Takes just 2 seconds!",
    };
  } catch (err: any) {
    console.warn('[Gemini Vision Selfie Validator Notice]:', err?.message || err);
    return {
      isValid: false,
      isAiGenerated: false,
      hasSingleHumanFace: false,
      isCloseUpHeadshot: false,
      reason: 'Could not process photo format.',
      userGuidance: "Thanks for sending that! We couldn't quite see a clear photo of your face. Could you send a quick photo or selfie showing your face clearly? Takes just 2 seconds!",
    };
  }
}

/**
 * Detects if a user in an active Floate Secure Line relay chat wants to end/exit the session.
 * Uses fast regex matching for standard phrases, with Gemini natural language fallback for variations.
 */
export async function isEndChatIntent(userInput: string): Promise<boolean> {
  const text = (userInput || '').trim();
  const lower = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();

  // Fast regex detection for common phrasing
  if (
    /^(end|end chat|endchat|close chat|stop chat|exit chat|leave chat|quit chat|end session|leave session|close session|stop session|end conversation|stop conversation|cancel chat|close|exit|leave|quit|goodbye|bye|i want to leave|disconnect|stop|cancel)$/i.test(
      lower
    )
  ) {
    return true;
  }

  // If text is short or clearly a commerce statement, don't query AI
  if (text.length < 4 || /price|naira|how much|send|account|where|delivery|pay|item|color|size|discount/i.test(lower)) {
    return false;
  }

  const ai = getAIClient();
  if (!ai) return false;

  try {
    const prompt = `A user is participating in an anonymous real-time buyer-seller chat on WhatsApp.
Determine if the user's message is an explicit request to leave, end, close, or terminate the chat session.

User message: "${userInput}"

Respond with strictly JSON:
{ "isEndChat": true | false }`;

    const response = await generateContentWithFallback(ai, { contents: prompt }).catch(() => null);
    const jsonText = response?.text?.trim() || '';
    if (!jsonText) return false;
    const cleanJson = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    return Boolean(parsed.isEndChat);
  } catch {
    return false;
  }
}

export interface MutualAgreementResult {
  hasAgreed: boolean;
  item: string;
  agreedPrice: string;
  terms?: string;
  confidence: number;
}

/**
 * Uses Gemini to analyze chat exchanges between buyer and vendor on Floate Secure Line
 * to detect genuine mutual agreement (price, item, and terms confirmed by both sides).
 */
export async function detectMutualAgreement(
  messages: Array<{ senderRole: 'BUYER' | 'VENDOR'; text: string }>,
  defaultItemName: string = 'Item'
): Promise<MutualAgreementResult | null> {
  if (!messages || messages.length < 2) return null;

  // Verify both buyer and vendor have contributed at least one message
  const hasBuyer = messages.some((m) => m.senderRole === 'BUYER');
  const hasVendor = messages.some((m) => m.senderRole === 'VENDOR');
  if (!hasBuyer || !hasVendor) return null;

  const conversationTranscript = messages
    .slice(-10) // analyze the last 10 exchanges
    .map((m) => `${m.senderRole}: ${m.text}`)
    .join('\n');

  const ai = getAIClient();
  if (!ai) return null;

  try {
    const prompt = `You are the Floate Commerce Mutual Agreement Evaluator.
Analyze this chat between a BUYER and a VENDOR regarding "${defaultItemName}".
Determine if there is a genuine MUTUAL AGREEMENT where:
1. Both parties agree on the exact item or specifications.
2. Both parties have settled and agreed on a final price (in Naira / ₦).
3. The transaction is mutually confirmed by both sides (e.g. "deal", "I agree", "send payment", "I'll take it at that price", "ok agreed", "deal done").

Conversation transcript:
${conversationTranscript}

Output strictly in JSON:
{
  "hasAgreed": true | false,
  "item": "Name of agreed product/service",
  "agreedPrice": "Agreed price with Naira symbol (e.g. ₦25,000)",
  "terms": "Summary of agreed delivery or fulfillment terms if mentioned",
  "confidence": 0.95
}
Return ONLY valid JSON.`;

    const response = await generateContentWithFallback(ai, { contents: prompt }).catch(() => null);
    const jsonText = response?.text?.trim() || '';
    if (!jsonText) return null;
    const cleanJson = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (parsed.hasAgreed && (parsed.confidence ?? 0.8) >= 0.7) {
      return {
        hasAgreed: true,
        item: parsed.item || defaultItemName,
        agreedPrice: parsed.agreedPrice || 'Agreed Price',
        terms: parsed.terms || undefined,
        confidence: parsed.confidence || 0.9,
      };
    }
    return null;
  } catch (err) {
    console.warn('[Gemini Agreement Evaluator Notice]:', err);
    return null;
  }
}

/**
 * Checks if a user message is a conversational greeting, check-in, or brand question.
 */
export async function isConversationalOrBrandQuestion(userInput: string): Promise<boolean> {
  const text = (userInput || '').trim();
  const lower = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();

  if (
    /^(hi|hello|hey|good morning|good afternoon|good evening|how are you|how are you doing|how far|how body|how things|how is your day|what's up|whats up|sup|how's it going|who are you|what is floate|about floate|tell me about floate|what do you do|what can you do|who made floate)$/i.test(
      lower
    )
  ) {
    return true;
  }

  // If user is searching or typing an obvious commerce item, return false
  if (/^(i want to buy|how much is|where can i get|shoes|phone|laptop|bag|cloth|price|cost|naira|delivery|waybill)/i.test(lower)) {
    return false;
  }

  const ai = getAIClient();
  if (!ai) return false;

  try {
    const prompt = `Determine if the following user message to Floate (an African conversational commerce platform on WhatsApp) is a casual conversational check-in, greeting, or brand inquiry (e.g. "how are you", "what is Floate about", "who made this", "hello floate") as opposed to an explicit product search or transaction action.

User message: "${userInput}"

Respond with strictly JSON:
{ "isConversationalOrBrand": true | false }`;

    const response = await generateContentWithFallback(ai, { contents: prompt }).catch(() => null);
    const jsonText = response?.text?.trim() || '';
    if (!jsonText) return false;
    const cleanJson = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    return Boolean(parsed.isConversationalOrBrand);
  } catch {
    return false;
  }
}

/**
 * Generates an on-brand, natural, warm, varied Gemini-powered response
 * for casual check-ins, greetings, and Floate brand questions.
 */
export async function generateBrandConversationalResponse(
  userInput: string,
  userName?: string,
  userCity?: string
): Promise<string> {
  const ai = getAIClient();
  const cleanName = userName && userName !== 'Customer' ? userName.trim() : '';

  if (!ai) {
    // Fallback warm conversational response
    if (/how are you|how far|how you dey/i.test(userInput)) {
      return cleanName
        ? `Hello ${cleanName}, I'm doing great and ready to help you find verified sellers or items anywhere in Nigeria! What are you shopping for today?`
        : `Hello, I'm doing great and ready to help you find verified sellers or items anywhere in Nigeria! What are you shopping for today?`;
    }
    return cleanName
      ? `Hello ${cleanName}! Floate connects you directly with verified shops, artisans, and sellers across Nigeria with zero middleman fees and escrow protection. What would you like to find today?`
      : `Hello! Floate connects you directly with verified shops, artisans, and sellers across Nigeria with zero middleman fees and escrow protection. What would you like to find today?`;
  }

  try {
    const prompt = `You are Floate AI, the friendly, articulate, and reliable conversational commerce assistant for Nigeria & Africa on WhatsApp.

Context:
- User Name: ${cleanName || 'Friend'}
- User City / Location: ${userCity || 'Nigeria'}
- User Message: "${userInput}"

Floate's Brand Identity & Capabilities:
- Floate is a zero-commission conversational commerce network connecting buyers directly with verified sellers across major commercial hubs (Onitsha Main Market, Computer Village Ikeja, Balogun Lagos, Alaba, Trade Fair, Wuse Abuja, etc.).
- Offers anonymous Floate Secure Line chats and Floate SafePay (escrow via Flutterwave) for safe trading.
- Allows merchants to list products, manage inventory, and receive direct buyer leads.

Instructions:
1. Respond warmly, naturally, and conversationally in 2 to 3 concise sentences.
2. Maintain an authentic Nigerian warmth (refined English with natural warmth, polite, friendly, never robotic or canned).
3. If they asked how you are doing, answer warmly first, then invite them to discover items or sellers.
4. If they asked what Floate is or does, explain Floate's purpose cleanly and invite them to search or list their shop.
5. Do NOT use decorative emojis (no stars, rocket emojis, or excessive icons). Use WhatsApp single asterisks (*bold*) for emphasis if needed.

Generate the exact message to send to the user:`;

    const response = await generateContentWithFallback(ai, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }).catch(() => null);

    const generated = response?.text?.trim();
    if (generated && generated.length > 10) {
      return generated;
    }

    return `Hello${cleanName ? ' ' + cleanName : ''}! I'm doing well, thank you. Floate connects you directly to verified sellers across Nigerian markets with secure payments. What would you like to shop for today?`;
  } catch (err) {
    console.warn('[Gemini Brand Conversational AI Notice]:', err);
    return `Hello${cleanName ? ' ' + cleanName : ''}! I'm doing very well, thank you. How can I help you with your shopping or business today?`;
  }
}



