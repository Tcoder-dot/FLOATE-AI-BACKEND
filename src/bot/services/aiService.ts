import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

let aiInstance: GoogleGenAI | null = null;

/** Helper function to guarantee AI calls time out within specified milliseconds */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 5000, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

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
 * Executes a Gemini generateContent request with automatic model fallbacks when facing quota (429) or high demand (503) errors.
 */
async function generateContentWithFallback(
  ai: GoogleGenAI,
  requestParams: Omit<Parameters<typeof ai.models.generateContent>[0], 'model'>,
  modelsToTry: string[] = ['gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest']
) {
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
  isConversational?: boolean; // True if user is greeting, asking how are you, praising, or asking vague chat
  conversationalReply?: string; // Natural human response asking "how can I help you today?"
  friendlyAck?: string;
}

export interface ConversationalIntentResult {
  isConversational: boolean;
  isReportRequest?: boolean;
  replyText?: string;
  intent?: 'BRAND_QUESTION' | 'OFF_TOPIC' | 'SHOPPING_SEARCH' | 'REPORT_DISPUTE';
}

export interface QueryIntentClassification {
  intent: 'SHOPPING_SEARCH' | 'BRAND_QUESTION' | 'OFF_TOPIC' | 'REPORT_DISPUTE';
  conversationalReply?: string;
  cleanKeywords?: string;
  category?: string;
  location?: string;
  isRegistrationRequest?: boolean;
}

/**
 * Fast deterministic conversational intent classifier for greetings, pleasantries, compliments, identity, and support/reporting questions.
 */
export function getConversationalIntent(rawText: string, senderName?: string): ConversationalIntentResult | null {
  const text = rawText.toLowerCase().trim();
  const clean = text.replace(/[^a-z0-9 _]+/g, '').replace(/\s+/g, ' ');
  const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
  const prefix = name ? `Hello ${name}, ` : 'Hello, ';

  // 1. Report a vendor / Scam / Fraud / Complaint / Dispute
  if (
    /\b(report\s+(a\s+)?(vendor|seller|shop|business|store|merchant)|report\s+them|report\s+him|report\s+her|i want to report|scam|fraud|scammer|fake vendor|fake seller|scammed|cheated|stole my money|stolen|vendor problem|vendor issue|dispute|complaint)\b/i.test(clean) ||
    /^(report|report vendor|report a vendor|report business|report scam|scam|fraud|complaint)$/i.test(clean)
  ) {
    return {
      isConversational: true,
      isReportRequest: true,
      intent: 'REPORT_DISPUTE',
      replyText: `${prefix}I am sorry to hear you are having an issue. Please tell me what happened, what the vendor did, and the vendor's name or phone number so we can look into it for you.`,
    };
  }

  // 2. General Support / Customer Care Inquiries
  if (
    /\b(customer care|customer service|help desk|contact support|contact us|contact email|support email)\b/i.test(clean) ||
    /^(support|help|customer care)$/i.test(clean)
  ) {
    return {
      isConversational: true,
      intent: 'BRAND_QUESTION',
      replyText: `${prefix}for general inquiries you can reach us at support@floate.xyz, or if you need to report a vendor or issue, please describe what happened so we can assist you.`,
    };
  }

  // 3. "How are you" / "How are you doing" / "How is your day" / "How far"
  if (
    /^(hello|hi|hey)?\s*(floate\s*)?(how (are|r) (you|u)|how (are|r) (you|u) doing|how is your day|hows your day|how is everything|how body|how you dey|how things|hope (you are|youre|all is) (good|fine|well|great)|what'?s up|wassup)(\s*floate)?$/i.test(clean) ||
    /\b(how are you doing today|how are you today|how are you|how is your day going|hope your day is going well)\b/i.test(clean)
  ) {
    return {
      isConversational: true,
      intent: 'BRAND_QUESTION',
      replyText: `${prefix}I am doing well, thank you. How can I help you today?`,
    };
  }

  // 4. Compliments / Appreciation ("You're doing a nice job", "Well done", "Thank you")
  if (
    /\b(you('?re| are) doing (a )?(nice|great|good|wonderful|amazing) job|nice job|great job|good job|well done|you are doing great|thank you so much|thank you|thanks a lot|appreciate your help|appreciate you)\b/i.test(clean) ||
    /^(thank you|thanks|thanks floate|thank you floate|well done|nice one|good job|great work)$/i.test(clean)
  ) {
    return {
      isConversational: true,
      intent: 'BRAND_QUESTION',
      replyText: `${prefix}thank you so much. What would you like to shop for today?`,
    };
  }

  // 5. Identity & About ("Who are you", "What is Floate", "What do you do", "How does this work")
  if (
    /^(who (are|r) (you|u)|what is floate|what do you do|what can you do|how does (this|floate) work|introduce yourself|tell me about floate)(\s+floate)?$/i.test(clean)
  ) {
    return {
      isConversational: true,
      intent: 'BRAND_QUESTION',
      replyText: `${prefix}Floate is your intelligent Nigerian commerce platform connecting you directly with verified merchants, major open markets, and service professionals nationwide. What would you like to shop for today?`,
    };
  }

  // 6. Pure Greetings ("Hello floate", "Hi", "Good morning", "Good afternoon", "Good evening")
  if (
    /^(hello|hi|hey|good morning|good afternoon|good evening|good day|greetings|start)(\s+(floate|flote|there|ai|bot))?$/i.test(clean) ||
    /^(hello floate|hello_floate|hellofloate|hi floate|hi_floate|hifloate|good morning floate|good afternoon floate|good evening floate)$/i.test(clean)
  ) {
    return {
      isConversational: true,
      intent: 'BRAND_QUESTION',
      replyText: `${prefix}what would you like to shop for today?`,
    };
  }

  // 7. Off-Topic Chit Chat Fallback Patterns (Jokes, weather, code, personal trivia)
  if (
    /^(tell me a joke|write a poem|write code|who is the president|what is the weather|what time is it|sing a song|are you single|tell me about yourself)$/i.test(clean)
  ) {
    return {
      isConversational: true,
      intent: 'OFF_TOPIC',
      replyText: `${prefix}I am just here to help you find what you need on Floate. What are you shopping for today?`,
    };
  }

  return null;
}

/**
 * Lightweight Gemini Intent Classification Layer:
 * Evaluates whether a query is a genuine brand question, off-topic chit-chat, or shopping search.
 */
export async function classifyQueryIntentWithGemini(userQuery: string, senderName?: string): Promise<QueryIntentClassification> {
  const norm = (userQuery || '').trim();
  const name = senderName && senderName !== 'Customer' ? senderName.trim() : '';
  const prefix = name ? `Hello ${name}, ` : 'Hello, ';

  // Check deterministic rules first
  const deterministic = getConversationalIntent(norm, senderName);
  if (deterministic) {
    if (deterministic.intent === 'REPORT_DISPUTE') {
      return { intent: 'REPORT_DISPUTE', conversationalReply: deterministic.replyText };
    }
    if (deterministic.intent === 'BRAND_QUESTION') {
      return { intent: 'BRAND_QUESTION', conversationalReply: deterministic.replyText };
    }
    if (deterministic.intent === 'OFF_TOPIC') {
      return { intent: 'OFF_TOPIC', conversationalReply: deterministic.replyText };
    }
  }

  const ai = getAIClient();
  if (!ai) {
    return { intent: 'SHOPPING_SEARCH', cleanKeywords: norm };
  }

  try {
    const response = await generateContentWithFallback(ai, {
      contents: `You are the intent classification and brand voice engine for Floate (African & Nigerian commerce platform).
A user sent this message: "${norm}"

Task: Classify this message into one of three intents:
1. "BRAND_QUESTION": The user is asking about Floate, how Floate works, what businesses or markets are available, how vendor registration works, safety, contact/support, or how to buy/sell on Floate.
   -> Provide "conversationalReply": A helpful, natural, accurate 1-line answer in standard Nigerian English. Strictly NO emojis, straight line answer with no paragraph breaks.
2. "OFF_TOPIC": The user is asking something completely unrelated to shopping, commerce, products, services, or Floate (e.g. general chit-chat, jokes, unrelated personal questions, coding, trivia, politics).
   -> Provide "conversationalReply": A polite, warm redirect back to shopping e.g. "${prefix}I am just here to help you find what you need on Floate. What are you shopping for today?" (NO emojis, straight line).
3. "SHOPPING_SEARCH": The user is searching for a product, service, item, price, or vendor to buy or hire (e.g. "shoes in onitsha", "iphone 13", "video editor", "lawyer", "solar inverter", "where can i buy wigs").
   -> "cleanKeywords": The clean product/service name without conversational fluff.

Return strictly JSON:
{
  "intent": "BRAND_QUESTION" | "OFF_TOPIC" | "SHOPPING_SEARCH",
  "conversationalReply": "string or null",
  "cleanKeywords": "string or null",
  "category": "string or null",
  "location": "string or null"
}`,
    });

    const text = response.text || '';
    const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const json = JSON.parse(cleanJson);

    if (json.intent === 'BRAND_QUESTION' || json.intent === 'OFF_TOPIC') {
      let reply = json.conversationalReply || `${prefix}what would you like to shop for today?`;
      // Ensure no emojis and straight line
      reply = reply.replace(/[\u{1F600}-\u{1F6FF}|\u{1F300}-\u{1F5FF}|\u{1F680}-\u{1F6FF}|\u{1F1E0}-\u{1F1FF}|\u{2600}-\u{26FF}|\u{2700}-\u{27BF}]/gu, '').replace(/\n+/g, ' ').trim();
      return {
        intent: json.intent,
        conversationalReply: reply,
      };
    }

    return {
      intent: 'SHOPPING_SEARCH',
      cleanKeywords: json.cleanKeywords || norm,
      category: json.category || undefined,
      location: json.location || undefined,
    };
  } catch (err) {
    console.warn('[Gemini Intent Classifier Notice]:', err);
    return { intent: 'SHOPPING_SEARCH', cleanKeywords: norm };
  }
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

Task: Extract structured details:
1. "isConversational": true if this message is a greeting, pleasantry, compliment, "how are you" question, or general conversational chit-chat rather than a search for a specific product or service to buy.
2. "conversationalReply": If isConversational is true, provide a warm, natural 1-2 sentence response greeting them, acknowledging their question or compliment politely, and asking "How can I help you today? What would you like to shop for?" (in natural Nigerian English).
3. "cleanProduct": The clean main product or service name ONLY (e.g. "Phone", "Laptop", "Lawyer", "Video Editor", "Leather Slippers"). Strip out conversational noise like "I want to buy", "I need a", "looking for someone to". If isConversational is true and no item was mentioned, set to null.
4. "maxPriceNaira": Maximum budget in Nigerian Naira as a number (e.g., "200k" -> 200000, "5k" -> 5000, "1.5m" -> 1500000). Return null if no budget mentioned.
5. "buyerLocation": The BUYER's own location if mentioned (e.g. "my location is Agbani", "I stay in Agbani" -> "Agbani").
6. "targetSellerLocation": The required SELLER location (State, City, or Market Area) if user mentioned a seller location or location preference (e.g., "seller in Enugu", "in Onitsha", "from Lagos", "in Agbani", "in Imo"). If user only gave their own location, set targetSellerLocation to null.
7. "category": Broad product or service category (e.g. "Phones & Accessories", "Computers", "Legal Services", "Media & Video Production", "Footwear", "Clothing").
8. "inferredCategories": An array of 3 to 6 tightly-related business category names, service types, or synonym terms that represent businesses capable of fulfilling this request.
   Examples:
   - "I need a lawyer" -> ["Legal Services", "Legal Consultation", "Attorney", "Law Firm", "Lawyer", "Legal Advocate"]
   - "someone to edit my videos" -> ["Video Editor", "Video Editing Services", "Videographer", "Media Production", "Content Creation"]
   - "car mechanic" -> ["Auto Repair", "Car Mechanic", "Automobile Repairs", "Auto Mechanic"]
   - "catering for wedding" -> ["Catering Services", "Caterer", "Event Catering", "Food Services"]
   - "leather slippers" -> ["Footwear", "Leather Slippers", "Shoes", "Plaited Slippers", "Sandals"]
   Do NOT include vague/overly broad words like "Business", "Services", "Shop", "General", "Other".
9. "itemType": Either "product" or "service". Determine whether the clean item requested represents a physical product (e.g. "Phone", "Cloth", "Shoes", "Generator") or a service/profession to be hired or booked (e.g. "Lawyer", "Video Editor", "Mechanic", "Catering", "Graphic Designer", "Tutor", "Consultant", "Photographer").
10. "isRegistrationRequest": true ONLY if user wants to register as a business/seller.

Return ONLY valid JSON format like:
{
  "isConversational": false,
  "conversationalReply": null,
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
        isConversational: Boolean(json.isConversational),
        conversationalReply: json.conversationalReply || undefined,
        friendlyAck: `Connecting you to a verified seller for ${json.cleanProduct || 'items'}...`,
      };
    } catch (err) {
      console.warn('AI query parsing notice, using fallback:', err);
      return fallbackQueryParse(userQuery);
    }
  })();

  // Guarantee maximum 5 second response time
  const result = await withTimeout(queryTask, 5000, fallbackQueryParse(userQuery));
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

  return withTimeout(replyTask, 5000, "Looking up sellers across Nigeria...");
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

    const response = await withTimeout(
      generateContentWithFallback(ai, {
        contents: prompt,
      }),
      3500,
      null
    );

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

    const response = await withTimeout(
      generateContentWithFallback(ai, { contents: prompt }),
      4500,
      null
    );

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

    const response = await withTimeout(
      generateContentWithFallback(ai, {
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
      }),
      9000,
      null
    );

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



