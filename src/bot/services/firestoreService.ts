import { initializeApp, getApps, getApp } from 'firebase/app';
import { InlineKeyboard } from 'grammy';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  runTransaction,
} from 'firebase/firestore';
import fs from 'fs';
import path from 'path';
import { sheetsDb, normalizePhone, BusinessListing, parsePriceToNumber, VendorMatchScore } from './sheetsService.js';
import { extractInventoryFromVoiceOrPhoto, ExtractedInventoryData } from './aiService.js';

// Load Firebase configuration with static fallbacks for production container deployment
const defaultConfig = {
  projectId: "gen-lang-client-0100438151",
  appId: "1:328819263704:web:a51c1a314660eb577a6fad",
  apiKey: "AIzaSyB2_TEAHF-hSkKyrQva8HTI0F95OnIji6M",
  authDomain: "gen-lang-client-0100438151.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-10224e22-6d13-470a-8a28-6cc942bc5d67",
  storageBucket: "gen-lang-client-0100438151.firebasestorage.app",
  messagingSenderId: "328819263704",
};

let firebaseConfig: any = { ...defaultConfig };
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const fileData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    firebaseConfig = { ...defaultConfig, ...fileData };
  }
} catch (e) {
  console.warn('[FirestoreInit] Could not load firebase-applet-config.json, using defaults:', e);
}

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

export type SessionState = 'IDLE_SEARCH' | 'QUALIFYING' | 'IN_SESSION';

export interface PendingReviewMerchantDoc {
  id: string; // Phone or ID
  userId?: string | number;
  telegramId?: string | number;
  businessName: string;
  ownerFullName?: string;
  whatsapp: string;
  state?: string;
  city?: string;
  listingType?: string;
  category?: string;
  product?: string;
  price?: string;
  negotiation?: string;
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
  safetyReason?: string;
  safetyFlags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MerchantDoc {
  id: string; // Merchant ID or Phone
  businessName: string;
  ownerFullName?: string; // Owner's Full Name (First & Last Name - Protected from public view)
  whatsapp: string;
  userId?: string | number;
  telegramId?: string | number;
  claimDate?: string;
  verifiedStatus?: 'YES' | 'PENDING';
  username?: string;
  state?: string;
  city?: string;
  category?: string;
  listingType?: string;
  isVerified?: boolean;
  credit_balance: number; // Balance in NGN (default 1000 NGN = 5 leads for new merchants)
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING_REVIEW';
  updatedAt: string;
}

export interface SearchLogDoc {
  id: string;
  buyerTelegramId: string | number;
  buyerName: string;
  searchedProduct: string;
  searchedPrice: string;
  searchedLocation: string;
  matchFound: 'Yes' | 'No';
  numberOfMatches: number;
  timestamp: string;
}

export interface ProductDoc {
  id: string;
  merchantId: string;
  userId?: string | number;
  businessName: string;
  whatsapp: string;
  state?: string;
  city?: string;
  listingType: 'Product' | 'Service';
  category: string;
  product: string;
  price: string;
  numericPrice?: number;
  negotiation?: 'Yes' | 'No';
  quantity?: number;
  specs?: string;
  photoUrl?: string;
  updatedAt: string;
}

export interface RestockAlertDoc {
  id: string;
  productId: string;
  productName: string;
  merchantId: string;
  merchantName: string;
  buyerTelegramId: string | number;
  buyerName?: string;
  status: 'SENT' | 'PENDING';
  timestamp: string;
}

export function isServiceItem(item: string, category?: string): boolean {
  const text = `${item} ${category || ''}`.toLowerCase();
  const serviceKeywords = [
    'service', 'legal', 'lawyer', 'consult', 'consulting', 'design', 'editing', 'edit',
    'repair', 'cleaning', 'catering', 'photography', 'photo', 'video', 'rent', 'rental',
    'agent', 'developer', 'tutoring', 'barber', 'salon', 'makeup', 'writing', 'installation',
    'plumbing', 'electrician', 'mechanic', 'tailor', 'fashion design', 'hairstylist', 'coach',
    'advisory', 'advocate', 'audit', 'accounting', 'tax'
  ];
  return serviceKeywords.some(kw => text.includes(kw));
}

export function getIndefiniteArticle(word: string): string {
  const trimmed = word.trim().toLowerCase();
  if (trimmed.startsWith('a ') || trimmed.startsWith('an ')) return '';
  const vowels = ['a', 'e', 'i', 'o', 'u'];
  return vowels.includes(trimmed.charAt(0)) ? 'an' : 'a';
}

export function formatWhatsAppMsg(
  merchantName?: string,
  item?: string,
  location?: string,
  budget?: string,
  urgency?: string,
  category?: string
): string {
  if (merchantName && merchantName.trim()) {
    return `HI ${merchantName.trim().toUpperCase()}, I found you on FLOATE.`;
  }
  return `HI, I found you on FLOATE.`;
}

export interface UserSessionDoc {
  userId: string | number;
  state: SessionState;
  selectedMerchantId?: string;
  selectedMerchantName?: string;
  selectedMerchantTelegramId?: string | number;
  selectedMerchantWhatsapp?: string;
  selectedItem?: string;
  deliveryLocation?: string;
  budget?: string;
  urgency?: string;
  activeQualificationId?: string;
  hasSeenSaveTip?: boolean;
  updatedAt: string;
}

export interface QualificationSessionDoc {
  id: string;
  buyerId: string | number;
  buyerUsername: string;
  merchantId: string;
  merchantName: string;
  merchantWhatsapp: string;
  merchantTelegramId?: string | number;
  item: string;
  deliveryLocation?: string;
  budget?: string;
  urgency?: string;
  status: 'PENDING_LOCATION' | 'PENDING_BUDGET' | 'PENDING_URGENCY' | 'PENDING_MERCHANT' | 'QUALIFIED' | 'EXPIRED' | 'CANCELLED';
  createdAt: string;
  updatedAt: string;
}

export interface LeadDoc {
  id: string;
  ref: string;
  buyerId: string | number;
  buyerUsername: string;
  merchantId: string;
  merchantName: string;
  merchantWhatsapp: string;
  item: string;
  location: string;
  cost: number; // 200 NGN
  waLink: string;
  timestamp: string;
}

export interface TransactionDoc {
  id: string;
  merchantId: string;
  merchantName: string;
  type: 'TOPUP' | 'LEAD_DEDUCTION';
  amount: number;
  description: string;
  reference: string;
  timestamp: string;
}

export class FirestoreService {
  public static readonly MONETIZATION_ENABLED = false; // Set to true to re-enable credit deductions & wallet checks
  private defaultInitialCredits = 1000; // 1,000 NGN bonus = 5 initial leads
  private leadCostNGN = 200; // 200 NGN per qualified lead

  // In-memory fallback / cache for fast access
  private localSessions: Map<string, UserSessionDoc> = new Map();

  /**
   * Recursively sanitizes objects for Firestore setDoc / updateDoc calls
   * by replacing any `undefined` value with `""` (empty string) to prevent
   * [FirebaseError: Function setDoc() called with invalid data. Unsupported field value: undefined]
   */
  private sanitizeForFirestore<T extends Record<string, any>>(obj: T): T {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) {
        sanitized[key] = '';
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeForFirestore(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map(item =>
          item !== null && typeof item === 'object'
            ? this.sanitizeForFirestore(item)
            : (item === undefined ? '' : item)
        );
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized as T;
  }

  /**
   * Syncs / seeds merchants from Google Sheets listings into Firestore
   */
  public async syncMerchantsFromListings(listings: BusinessListing[]): Promise<void> {
    try {
      for (const listing of listings) {
        const merchantId = listing.id || listing.whatsapp || normalizePhone(listing.whatsapp);
        if (!merchantId) continue;

        const merchantRef = doc(db, 'merchants', merchantId);
        const snap = await getDoc(merchantRef);

        const tgId = listing.telegramId || listing.userId;
        const cDate = listing.claimDate || new Date().toISOString().split('T')[0];
        const vStatus: 'YES' | 'PENDING' = listing.verifiedStatus || (listing.isVerified ? 'YES' : 'PENDING');

        if (!snap.exists()) {
          const newMerchant: MerchantDoc = {
            id: merchantId,
            businessName: listing.businessName || '',
            ownerFullName: listing.ownerFullName || '',
            whatsapp: listing.whatsapp || '',
            userId: listing.userId ?? '',
            telegramId: tgId ?? '',
            claimDate: cDate || '',
            verifiedStatus: vStatus,
            state: listing.state || '',
            city: listing.city || '',
            category: listing.category || '',
            listingType: listing.listingType || '',
            isVerified: vStatus === 'YES' || listing.isVerified || false,
            credit_balance: this.defaultInitialCredits,
            status: 'ACTIVE',
            updatedAt: new Date().toISOString(),
          };
          await setDoc(merchantRef, this.sanitizeForFirestore(newMerchant));
        } else {
          // Update verification/telegram details if changed
          const updates: Partial<MerchantDoc> = {
            updatedAt: new Date().toISOString(),
          };
          if (listing.ownerFullName) updates.ownerFullName = listing.ownerFullName;
          if (listing.userId !== undefined) updates.userId = listing.userId;
          if (tgId !== undefined) updates.telegramId = tgId;
          if (cDate !== undefined) updates.claimDate = cDate;
          if (vStatus !== undefined) {
            updates.verifiedStatus = vStatus;
            updates.isVerified = vStatus === 'YES';
          }
          await updateDoc(merchantRef, this.sanitizeForFirestore(updates));
        }
      }
    } catch (err) {
      console.warn('[Firestore] Error syncing merchants from listings:', err);
    }
  }

  /**
   * Synchronizes and logs buyer search query directly into Firestore search_logs collection
   */
  public async logSearch(data: Omit<SearchLogDoc, 'id'>): Promise<void> {
    try {
      const id = `search-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const docData: SearchLogDoc = {
        id,
        buyerTelegramId: data.buyerTelegramId ?? '',
        buyerName: data.buyerName || '',
        searchedProduct: data.searchedProduct || '',
        searchedPrice: data.searchedPrice || '',
        searchedLocation: data.searchedLocation || '',
        matchFound: data.matchFound || 'No',
        numberOfMatches: data.numberOfMatches || 0,
        timestamp: data.timestamp || new Date().toISOString(),
      };
      await setDoc(doc(db, 'search_logs', id), this.sanitizeForFirestore(docData));
    } catch (err) {
      console.warn('[Firestore] Error logging buyer search:', err);
    }
  }

  /**
   * Retrieves all merchants for admin review
   */
  public async getAllMerchantsForAdmin(): Promise<MerchantDoc[]> {
    try {
      const q = collection(db, 'merchants');
      const snap = await getDocs(q);
      const list: MerchantDoc[] = [];
      snap.forEach((d) => list.push(d.data() as MerchantDoc));
      return list;
    } catch (err) {
      console.error('[Firestore] Error fetching all merchants for admin:', err);
      return [];
    }
  }

  /**
   * Retrieves a merchant by ID or WhatsApp
   */
  public async getMerchant(merchantId: string): Promise<MerchantDoc | null> {
    try {
      const snap = await getDoc(doc(db, 'merchants', merchantId));
      if (snap.exists()) {
        return snap.data() as MerchantDoc;
      }
      // Try search by whatsapp
      const normPhone = normalizePhone(merchantId);
      if (normPhone) {
        const q = query(collection(db, 'merchants'), where('whatsapp', '==', normPhone));
        const qSnap = await getDocs(q);
        if (!qSnap.empty) {
          return qSnap.docs[0].data() as MerchantDoc;
        }
      }
      return null;
    } catch (err) {
      console.error(`[Firestore] Error fetching merchant ${merchantId}:`, err);
      return null;
    }
  }

  /**
   * Get all active merchants
   * Bypasses credit balance checks when MONETIZATION_ENABLED is false (Launch Phase)
   */
  public async getActiveMerchants(): Promise<MerchantDoc[]> {
    try {
      const q = FirestoreService.MONETIZATION_ENABLED
        ? query(
            collection(db, 'merchants'),
            where('status', '==', 'ACTIVE'),
            where('credit_balance', '>=', this.leadCostNGN)
          )
        : query(
            collection(db, 'merchants'),
            where('status', '==', 'ACTIVE')
          );
      const snap = await getDocs(q);
      const list: MerchantDoc[] = [];
      snap.forEach((d) => list.push(d.data() as MerchantDoc));
      return list;
    } catch (err) {
      console.error('[Firestore] Error getting active merchants:', err);
      return [];
    }
  }

  /**
   * Multi-Tenant Session Router State Management
   * Ensures no fields are left as undefined before saving or returning
   */
  public async getUserSession(userId: string | number): Promise<UserSessionDoc> {
    const key = String(userId);
    if (this.localSessions.has(key)) {
      return this.localSessions.get(key)!;
    }

    try {
      const snap = await getDoc(doc(db, 'user_sessions', key));
      if (snap.exists()) {
        const raw = snap.data();
        const sess: UserSessionDoc = {
          userId: raw.userId ?? userId,
          state: raw.state || 'IDLE_SEARCH',
          selectedMerchantId: raw.selectedMerchantId ?? '',
          selectedMerchantName: raw.selectedMerchantName ?? '',
          selectedMerchantTelegramId: raw.selectedMerchantTelegramId ?? '',
          selectedMerchantWhatsapp: raw.selectedMerchantWhatsapp ?? '',
          selectedItem: raw.selectedItem ?? '',
          deliveryLocation: raw.deliveryLocation ?? '',
          budget: raw.budget ?? '',
          urgency: raw.urgency ?? '',
          activeQualificationId: raw.activeQualificationId ?? '',
          hasSeenSaveTip: raw.hasSeenSaveTip === true,
          updatedAt: raw.updatedAt || new Date().toISOString(),
        };
        this.localSessions.set(key, sess);
        return sess;
      }
    } catch (err) {
      console.warn(`[Firestore] Error loading user session ${key}:`, err);
    }

    const defaultSession: UserSessionDoc = {
      userId,
      state: 'IDLE_SEARCH',
      selectedMerchantId: '',
      selectedMerchantName: '',
      selectedMerchantTelegramId: '',
      selectedMerchantWhatsapp: '',
      selectedItem: '',
      deliveryLocation: '',
      budget: '',
      urgency: '',
      activeQualificationId: '',
      hasSeenSaveTip: false,
      updatedAt: new Date().toISOString(),
    };
    this.localSessions.set(key, defaultSession);
    return defaultSession;
  }

  public async setUserSession(userId: string | number, update: Partial<UserSessionDoc>): Promise<UserSessionDoc> {
    const key = String(userId);
    const current = await this.getUserSession(userId);
    const rawUpdated: UserSessionDoc = {
      ...current,
      ...update,
      userId,
      updatedAt: new Date().toISOString(),
    };

    // Explicitly guarantee all fields are non-undefined
    const cleanUpdated: UserSessionDoc = {
      userId: rawUpdated.userId,
      state: rawUpdated.state ?? 'IDLE_SEARCH',
      selectedMerchantId: rawUpdated.selectedMerchantId ?? '',
      selectedMerchantName: rawUpdated.selectedMerchantName ?? '',
      selectedMerchantTelegramId: rawUpdated.selectedMerchantTelegramId ?? '',
      selectedMerchantWhatsapp: rawUpdated.selectedMerchantWhatsapp ?? '',
      selectedItem: rawUpdated.selectedItem ?? '',
      deliveryLocation: rawUpdated.deliveryLocation ?? '',
      budget: rawUpdated.budget ?? '',
      urgency: rawUpdated.urgency ?? '',
      activeQualificationId: rawUpdated.activeQualificationId ?? '',
      hasSeenSaveTip: rawUpdated.hasSeenSaveTip ?? current.hasSeenSaveTip ?? false,
      updatedAt: rawUpdated.updatedAt,
    };

    this.localSessions.set(key, cleanUpdated);

    try {
      const sanitized = this.sanitizeForFirestore(cleanUpdated);
      await setDoc(doc(db, 'user_sessions', key), sanitized, { merge: true });
    } catch (err) {
      console.error(`[Firestore] Error persisting user session ${key}:`, err);
    }

    return cleanUpdated;
  }

  public async resetUserSession(userId: string | number): Promise<void> {
    const current = await this.getUserSession(userId);
    await this.setUserSession(userId, {
      state: 'IDLE_SEARCH',
      selectedMerchantId: '',
      selectedMerchantName: '',
      selectedMerchantTelegramId: '',
      selectedMerchantWhatsapp: '',
      selectedItem: '',
      deliveryLocation: '',
      budget: '',
      urgency: '',
      activeQualificationId: '',
      hasSeenSaveTip: current.hasSeenSaveTip ?? false,
    });
  }

  public async hasUserSeenSaveTip(userId: string | number): Promise<boolean> {
    const sess = await this.getUserSession(userId);
    return sess.hasSeenSaveTip === true;
  }

  public async markUserSeenSaveTip(userId: string | number): Promise<void> {
    await this.setUserSession(userId, { hasSeenSaveTip: true });
  }

  /**
   * Lead Qualification Firewall - Creates a new qualification session
   */
  public async createQualificationSession(
    buyerId: string | number,
    buyerUsername: string,
    merchant: { id: string; name: string; whatsapp: string; telegramId?: string | number },
    item: string
  ): Promise<QualificationSessionDoc> {
    const qualId = `qual-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const session: QualificationSessionDoc = {
      id: qualId,
      buyerId,
      buyerUsername: buyerUsername || 'Buyer',
      merchantId: merchant.id || '',
      merchantName: merchant.name || '',
      merchantWhatsapp: merchant.whatsapp || '',
      merchantTelegramId: merchant.telegramId ?? '',
      item: item || '',
      deliveryLocation: '',
      budget: '',
      urgency: '',
      status: 'PENDING_LOCATION',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await setDoc(doc(db, 'qualification_sessions', qualId), this.sanitizeForFirestore(session));
    } catch (err) {
      console.error('[Firestore] Error creating qualification session:', err);
    }

    await this.setUserSession(buyerId, {
      state: 'QUALIFYING',
      selectedMerchantId: merchant.id || '',
      selectedMerchantName: merchant.name || '',
      selectedMerchantWhatsapp: merchant.whatsapp || '',
      selectedMerchantTelegramId: merchant.telegramId ?? '',
      selectedItem: item || '',
      activeQualificationId: qualId,
    });

    return session;
  }

  /**
   * Get qualification session by ID
   */
  public async getQualificationSession(qualId: string): Promise<QualificationSessionDoc | null> {
    try {
      const ref = doc(db, 'qualification_sessions', qualId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      return snap.data() as QualificationSessionDoc;
    } catch (err) {
      console.error(`[Firestore] Error getting qualification session ${qualId}:`, err);
      return null;
    }
  }

  /**
   * Update qualification session location provided by buyer (Step 1)
   */
  public async setQualificationLocation(
    qualId: string,
    location: string
  ): Promise<QualificationSessionDoc | null> {
    try {
      const ref = doc(db, 'qualification_sessions', qualId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;

      const data = snap.data() as QualificationSessionDoc;
      const updated: QualificationSessionDoc = {
        ...data,
        deliveryLocation: location || '',
        status: 'PENDING_BUDGET',
        updatedAt: new Date().toISOString(),
      };

      await setDoc(ref, this.sanitizeForFirestore(updated), { merge: true });

      // Update buyer user session state
      await this.setUserSession(data.buyerId, {
        deliveryLocation: location || '',
      });

      return updated;
    } catch (err) {
      console.error(`[Firestore] Error updating location for ${qualId}:`, err);
      return null;
    }
  }

  /**
   * Update qualification session budget provided by buyer (Step 2)
   */
  public async setQualificationBudget(
    qualId: string,
    budget: string
  ): Promise<QualificationSessionDoc | null> {
    try {
      const ref = doc(db, 'qualification_sessions', qualId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;

      const data = snap.data() as QualificationSessionDoc;
      const updated: QualificationSessionDoc = {
        ...data,
        budget: budget || '',
        status: 'PENDING_URGENCY',
        updatedAt: new Date().toISOString(),
      };

      await setDoc(ref, this.sanitizeForFirestore(updated), { merge: true });

      await this.setUserSession(data.buyerId, {
        budget: budget || '',
      });

      return updated;
    } catch (err) {
      console.error(`[Firestore] Error updating budget for ${qualId}:`, err);
      return null;
    }
  }

  /**
   * Update qualification session urgency provided by buyer (Step 3)
   */
  public async setQualificationUrgency(
    qualId: string,
    urgency: string
  ): Promise<QualificationSessionDoc | null> {
    try {
      const ref = doc(db, 'qualification_sessions', qualId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;

      const data = snap.data() as QualificationSessionDoc;
      const updated: QualificationSessionDoc = {
        ...data,
        urgency: urgency || '',
        status: 'QUALIFIED',
        updatedAt: new Date().toISOString(),
      };

      await setDoc(ref, this.sanitizeForFirestore(updated), { merge: true });

      await this.setUserSession(data.buyerId, {
        urgency: urgency || '',
      });

      return updated;
    } catch (err) {
      console.error(`[Firestore] Error updating urgency for ${qualId}:`, err);
      return null;
    }
  }

  /**
   * Merchant confirms stock and accepts lead -> Triggers Lead Qualification Firewall & Billing Event
   */
  public async confirmStockAndDeductCredit(
    qualId: string
  ): Promise<{
    success: boolean;
    reason?: 'NOT_FOUND' | 'NO_LOCATION' | 'INSUFFICIENT_FUNDS' | 'ALREADY_PROCESSED';
    lead?: LeadDoc;
    waLink?: string;
    merchant?: MerchantDoc;
    buyerId?: string | number;
    item?: string;
    location?: string;
  }> {
    const qualRef = doc(db, 'qualification_sessions', qualId);

    try {
      const result = await runTransaction(db, async (transaction) => {
        const qualSnap = await transaction.get(qualRef);
        if (!qualSnap.exists()) {
          return { success: false, reason: 'NOT_FOUND' as const };
        }

        const qual = qualSnap.data() as QualificationSessionDoc;
        if (qual.status === 'QUALIFIED') {
          return { success: false, reason: 'ALREADY_PROCESSED' as const };
        }

        if (!qual.deliveryLocation) {
          return { success: false, reason: 'NO_LOCATION' as const };
        }

        // Get Merchant document inside transaction
        const merchantRef = doc(db, 'merchants', qual.merchantId);
        const merchantSnap = await transaction.get(merchantRef);

        let merchant: MerchantDoc;
        if (!merchantSnap.exists()) {
          // Initialize merchant if missing
          merchant = {
            id: qual.merchantId,
            businessName: qual.merchantName,
            whatsapp: qual.merchantWhatsapp,
            credit_balance: this.defaultInitialCredits,
            status: 'ACTIVE',
            updatedAt: new Date().toISOString(),
          };
          transaction.set(merchantRef, merchant);
        } else {
          merchant = merchantSnap.data() as MerchantDoc;
        }

        // Check wallet credit balance (200 NGN per lead) ONLY if monetization is enabled
        if (FirestoreService.MONETIZATION_ENABLED) {
          if (merchant.credit_balance < this.leadCostNGN) {
            // Deactivate merchant instantly from pool
            transaction.update(merchantRef, this.sanitizeForFirestore({
              status: 'INACTIVE',
              updatedAt: new Date().toISOString(),
            }));
            return {
              success: false,
              reason: 'INSUFFICIENT_FUNDS' as const,
              merchant,
              buyerId: qual.buyerId,
              item: qual.item,
              location: qual.deliveryLocation,
            };
          }
        }

        // Calculate lead cost and new balance (Deduct 200 NGN if MONETIZATION_ENABLED, else 0)
        const leadCost = FirestoreService.MONETIZATION_ENABLED ? this.leadCostNGN : 0;
        const newBalance = merchant.credit_balance - leadCost;
        const newStatus = 'ACTIVE'; // Merchants are NEVER set to INACTIVE while monetization is paused!

        if (leadCost > 0) {
          transaction.update(merchantRef, this.sanitizeForFirestore({
            credit_balance: newBalance,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          }));
        }

        // Generate unique transaction Ref ID
        const refId = `FLT-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const cleanPhone = normalizePhone(qual.merchantWhatsapp);

        // Construct pre-filled WhatsApp link using formatWhatsAppMsg
        const waMsg = formatWhatsAppMsg(
          qual.merchantName,
          qual.item,
          qual.deliveryLocation || 'N/A',
          qual.budget,
          qual.urgency
        );
        const waLink = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMsg)}`;

        const leadDoc: LeadDoc = {
          id: `lead-${Date.now()}`,
          ref: refId,
          buyerId: qual.buyerId ?? '',
          buyerUsername: qual.buyerUsername || '',
          merchantId: qual.merchantId || '',
          merchantName: qual.merchantName || '',
          merchantWhatsapp: qual.merchantWhatsapp || '',
          item: qual.item || '',
          location: qual.deliveryLocation || '',
          cost: leadCost,
          waLink: waLink || '',
          timestamp: new Date().toISOString(),
        };

        const leadRef = doc(db, 'leads', leadDoc.id);
        transaction.set(leadRef, this.sanitizeForFirestore(leadDoc));

        // Record Transaction doc
        const txnDoc: TransactionDoc = {
          id: `txn-${Date.now()}`,
          merchantId: qual.merchantId || '',
          merchantName: qual.merchantName || '',
          type: 'LEAD_DEDUCTION',
          amount: leadCost,
          description: leadCost > 0
            ? `Lead Qualification Firewall Cleared for "${qual.item}" in ${qual.deliveryLocation || 'N/A'} (Ref: ${refId})`
            : `Free Qualified Lead (Launch Phase) Cleared for "${qual.item}" in ${qual.deliveryLocation || 'N/A'} (Ref: ${refId})`,
          reference: refId,
          timestamp: new Date().toISOString(),
        };
        const txnRef = doc(db, 'transactions', txnDoc.id);
        transaction.set(txnRef, this.sanitizeForFirestore(txnDoc));

        // Mark qualification session as QUALIFIED
        transaction.update(qualRef, {
          status: 'QUALIFIED',
          updatedAt: new Date().toISOString(),
        });

        return {
          success: true,
          lead: leadDoc,
          waLink,
          merchant: { ...merchant, credit_balance: newBalance, status: newStatus },
          buyerId: qual.buyerId,
          item: qual.item,
          location: qual.deliveryLocation,
        };
      });

      if (result.success && result.lead) {
        // Trigger Google Sheets Passive Mirroring in background
        this.mirrorToGoogleSheets('LEAD_DEDUCTION', {
          merchantName: result.lead.merchantName,
          amount: result.lead.cost,
          newBalance: result.merchant?.credit_balance ?? 0,
          ref: result.lead.ref,
          buyerId: result.lead.buyerId,
          buyerUsername: result.lead.buyerUsername,
          item: result.lead.item,
          location: result.lead.location,
        });

        // Update buyer state to IN_SESSION or reset
        await this.setUserSession(result.lead.buyerId, {
          state: 'IN_SESSION',
        });
      }

      return result as any;
    } catch (err) {
      console.error('[Firestore] Transaction failed during confirmStockAndDeductCredit:', err);
      return { success: false, reason: 'NOT_FOUND' };
    }
  }

  /**
   * Top-up merchant wallet balance (Flutterwave API or Admin manual)
   */
  public async topupMerchantWallet(
    merchantId: string,
    amountNGN: number,
    paymentRef: string
  ): Promise<{ success: boolean; newBalance: number; merchantName: string }> {
    const merchantRef = doc(db, 'merchants', merchantId);

    try {
      const result = await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(merchantRef);
        let merchant: MerchantDoc;

        if (!snap.exists()) {
          merchant = {
            id: merchantId,
            businessName: `Merchant ${merchantId}`,
            whatsapp: merchantId,
            credit_balance: amountNGN,
            status: 'ACTIVE',
            updatedAt: new Date().toISOString(),
          };
          transaction.set(merchantRef, this.sanitizeForFirestore(merchant));
        } else {
          const current = snap.data() as MerchantDoc;
          const updatedBal = (current.credit_balance || 0) + amountNGN;
          merchant = {
            ...current,
            credit_balance: updatedBal,
            status: 'ACTIVE', // Automatically reactivate
            updatedAt: new Date().toISOString(),
          };
          transaction.update(merchantRef, this.sanitizeForFirestore({
            credit_balance: updatedBal,
            status: 'ACTIVE',
            updatedAt: new Date().toISOString(),
          }));
        }

        const txnDoc: TransactionDoc = {
          id: `topup-${Date.now()}`,
          merchantId,
          merchantName: merchant.businessName,
          type: 'TOPUP',
          amount: amountNGN,
          description: `Wallet top-up of ${amountNGN} NGN via Flutterwave (Ref: ${paymentRef})`,
          reference: paymentRef,
          timestamp: new Date().toISOString(),
        };

        const txnRef = doc(db, 'transactions', txnDoc.id);
        transaction.set(txnRef, this.sanitizeForFirestore(txnDoc));

        return {
          success: true,
          newBalance: merchant.credit_balance,
          merchantName: merchant.businessName,
        };
      });

      // Passive mirroring to Google Sheets
      this.mirrorToGoogleSheets('TOPUP', {
        merchantName: result.merchantName,
        amount: amountNGN,
        newBalance: result.newBalance,
        ref: paymentRef,
      });

      return result;
    } catch (err) {
      console.error(`[Firestore] Topup failed for merchant ${merchantId}:`, err);
      return { success: false, newBalance: 0, merchantName: '' };
    }
  }

  /**
   * Passive Google Sheets Mirroring
   * Does NOT block runtime calculations or introduce race conditions
   */
  private async mirrorToGoogleSheets(
    eventType: 'LEAD_DEDUCTION' | 'TOPUP',
    data: {
      merchantName: string;
      amount: number;
      newBalance: number;
      ref: string;
      buyerId?: string | number;
      buyerUsername?: string;
      item?: string;
      location?: string;
    }
  ) {
    try {
      const summary = eventType === 'LEAD_DEDUCTION'
        ? `[LEAD CHARGED] 200 NGN deducted for "${data.item}" in ${data.location}. Ref: ${data.ref}. New Balance: ${data.newBalance} NGN`
        : `[WALLET TOPUP] ${data.amount} NGN added. Ref: ${data.ref}. New Balance: ${data.newBalance} NGN`;

      await sheetsDb.logInteraction(
        data.buyerId || 'SYSTEM',
        data.buyerUsername || 'SYSTEM_LOG',
        eventType,
        `${data.merchantName} - ${summary}`
      );
    } catch (err) {
      console.warn('[Google Sheets Mirror Notice] Failed passive stream:', err);
    }
  }

  /**
   * Saves or updates a product listing in Firestore as the primary single source of truth
   */
  public async saveProductListing(data: {
    userId: number | string;
    businessName: string;
    whatsapp: string;
    state: string;
    city: string;
    listingType?: string;
    category: string;
    product: string;
    price: string;
    negotiation?: 'Yes' | 'No';
    quantity?: number;
    specs?: string;
    photoUrl?: string;
  }): Promise<ProductDoc> {
    const normPhone = normalizePhone(data.whatsapp);
    const merchantId = `biz-${normPhone || data.userId}`;
    const prodId = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const numPrice = parsePriceToNumber(data.price) || 0;

    const prodDoc: ProductDoc = {
      id: prodId,
      merchantId,
      userId: data.userId,
      businessName: data.businessName,
      whatsapp: data.whatsapp,
      state: data.state,
      city: data.city,
      listingType: (data.listingType as any) || 'Product',
      category: data.category || 'General',
      product: data.product,
      price: data.price,
      numericPrice: numPrice,
      negotiation: data.negotiation || 'Yes',
      quantity: data.quantity || 1,
      specs: data.specs || '',
      photoUrl: data.photoUrl || '',
      updatedAt: new Date().toISOString(),
    };

    try {
      // 1. Save directly to Firestore 'products' collection
      await setDoc(doc(db, 'products', prodId), this.sanitizeForFirestore(prodDoc));

      // 2. Ensure Merchant profile document in Firestore is updated/created
      const merchantRef = doc(db, 'merchants', merchantId);
      const mSnap = await getDoc(merchantRef);
      if (!mSnap.exists()) {
        const newMerchant: MerchantDoc = {
          id: merchantId,
          businessName: data.businessName || '',
          whatsapp: data.whatsapp || '',
          userId: data.userId ?? '',
          telegramId: data.userId ?? '',
          claimDate: new Date().toISOString().split('T')[0],
          verifiedStatus: 'YES',
          state: data.state || '',
          city: data.city || '',
          category: data.category || '',
          listingType: data.listingType || 'Product',
          isVerified: true,
          credit_balance: this.defaultInitialCredits,
          status: 'ACTIVE',
          updatedAt: new Date().toISOString(),
        };
        await setDoc(merchantRef, this.sanitizeForFirestore(newMerchant));
      } else {
        await updateDoc(merchantRef, this.sanitizeForFirestore({
          businessName: data.businessName || '',
          state: data.state || '',
          city: data.city || '',
          category: data.category || '',
          updatedAt: new Date().toISOString(),
        }));
      }

      // 3. Dual-write sync to Google Sheets for redundancy
      sheetsDb.registerBusiness({
        userId: data.userId,
        businessName: data.businessName,
        whatsapp: data.whatsapp,
        state: data.state,
        city: data.city,
        listingType: data.listingType,
        category: data.category,
        product: data.product,
        price: data.price,
        negotiation: data.negotiation,
      }).catch((e) => console.warn('[Firestore -> Sheets Dual Write Notice]:', e?.message));

    } catch (err) {
      console.error('[Firestore] Error saving product listing:', err);
    }

    return prodDoc;
  }

  /**
   * Reads all active product listings directly from Firestore
   */
  public async getProductsFromFirestore(): Promise<ProductDoc[]> {
    try {
      const q = collection(db, 'products');
      const snap = await getDocs(q);
      const list: ProductDoc[] = [];
      snap.forEach((d) => list.push(d.data() as ProductDoc));
      return list;
    } catch (err) {
      console.error('[Firestore] Error fetching products:', err);
      return [];
    }
  }

  /**
   * Search and score products from Firestore using automated lead matching logic
   */
  public async searchProductsWithLeadScoring(
    itemOrCategory: string,
    location?: string | null,
    budget?: string | null,
    urgency?: string | null
  ): Promise<VendorMatchScore[]> {
    // Primary read from Firestore products
    const firestoreProducts = await this.getProductsFromFirestore();
    let listings: BusinessListing[] = [];

    if (firestoreProducts.length > 0) {
      listings = firestoreProducts.map((p) => ({
        id: p.merchantId,
        userId: p.userId || p.merchantId,
        businessName: p.businessName,
        whatsapp: p.whatsapp,
        state: p.state || 'General',
        city: p.city || 'General',
        listingType: p.listingType,
        category: p.category,
        product: p.product,
        price: p.price,
        negotiation: p.negotiation || 'Yes',
        productCount: p.quantity || 1,
        isVerified: true,
        registeredSince: 'Jan 2026',
      }));
    } else {
      // Fallback
      listings = (sheetsDb as any).businessListings || [];
    }

    return sheetsDb.rankVendorsForLead(itemOrCategory, location, budget, urgency, listings);
  }

  /**
   * Broadcast Lead Radar: Scans Firestore search_logs for buyers who previously searched for
   * matching products/categories and alerts them via Telegram when new stock is posted!
   */
  public async triggerBroadcastLeadRadar(
    productDoc: {
      id?: string;
      businessName: string;
      product: string;
      price: string;
      city?: string;
      state?: string;
      whatsapp: string;
    },
    botApi?: any
  ): Promise<{ buyersNotifiedCount: number; notifiedBuyerIds: string[] }> {
    const prodNameNorm = productDoc.product.toLowerCase().trim();
    const notifiedBuyerIds: string[] = [];

    try {
      // Query recent buyer search logs in Firestore
      const snap = await getDocs(collection(db, 'search_logs'));
      const matchingLogs: SearchLogDoc[] = [];

      snap.forEach((d) => {
        const log = d.data() as SearchLogDoc;
        if (!log.buyerTelegramId) return;
        const searchedNorm = (log.searchedProduct || '').toLowerCase();
        if (
          searchedNorm.includes(prodNameNorm) ||
          prodNameNorm.includes(searchedNorm) ||
          (searchedNorm.length > 3 && prodNameNorm.includes(searchedNorm.slice(0, 4)))
        ) {
          matchingLogs.push(log);
        }
      });

      // Unique buyer IDs
      const uniqueBuyers = Array.from(new Set(matchingLogs.map((l) => String(l.buyerTelegramId))));
      const locStr = [productDoc.city, productDoc.state].filter(Boolean).join(', ') || 'Nigeria';

      for (const buyerId of uniqueBuyers) {
        // Log alert in Firestore
        const alertId = `alert-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const alertDoc: RestockAlertDoc = {
          id: alertId,
          productId: productDoc.id || 'N/A',
          productName: productDoc.product || '',
          merchantId: productDoc.whatsapp || '',
          merchantName: productDoc.businessName || '',
          buyerTelegramId: buyerId ?? '',
          buyerName: '',
          status: 'SENT',
          timestamp: new Date().toISOString(),
        };

        await setDoc(doc(db, 'restock_alerts', alertId), this.sanitizeForFirestore(alertDoc));
        notifiedBuyerIds.push(buyerId);

        // Send Telegram Broadcast Notification if bot instance is provided
        if (botApi && typeof botApi.sendMessage === 'function') {
          try {
            const messageText =
              `⚡ *FLOATE RESTOCK RADAR ALERT!* ⚡\n\n` +
              `Good news! Vendor *${productDoc.businessName}* in *${locStr}* just restocked or posted an item you searched for:\n\n` +
              `📦 *Product:* ${productDoc.product}\n` +
              `💰 *Price:* ${productDoc.price}\n\n` +
              `Tap below to verify availability and chat directly with the vendor!`;

            await botApi.sendMessage(buyerId, messageText, {
              parse_mode: 'Markdown',
            });
          } catch (msgErr) {
            console.warn(`[Broadcast Lead Radar] Could not send message to Telegram buyer ${buyerId}:`, msgErr);
          }
        }
      }
    } catch (err) {
      console.error('[Firestore] Error executing Broadcast Lead Radar:', err);
    }

    return {
      buyersNotifiedCount: notifiedBuyerIds.length,
      notifiedBuyerIds,
    };
  }

  public pendingInventoryDrafts: Map<string, {
    extracted: ExtractedInventoryData;
    photoUrl?: string;
    createdAt: string;
  }> = new Map();

  /**
   * Prepares an AI inventory draft from natural language voice, text, or photo caption
   * and returns the review text + inline confirmation keyboard.
   */
  public async prepareInventoryDraft(
    userId: string | number,
    textOrCaption: string,
    photoUrl?: string
  ): Promise<{
    extracted: ExtractedInventoryData;
    reviewText: string;
    inlineKeyboard: InlineKeyboard;
  }> {
    const key = String(userId);
    const extracted = await extractInventoryFromVoiceOrPhoto(textOrCaption);

    // Save pending draft
    this.pendingInventoryDrafts.set(key, {
      extracted,
      photoUrl,
      createdAt: new Date().toISOString(),
    });

    const merchant = await this.getMerchant(key);
    const state = extracted.state || merchant?.state || 'Lagos';
    const city = extracted.city || merchant?.city || 'Ikeja';
    const locStr = [city, state].filter(Boolean).join(', ');

    const reviewText =
      `📋 *AI INVENTORY SYNC DRAFT EXTRACTED!* 📋\n\n` +
      `Please review the extracted inventory details before saving to your Floate store catalog:\n\n` +
      `📦 *Product:* ${extracted.product}\n` +
      `💰 *Price:* ${extracted.price}\n` +
      `📂 *Category:* ${extracted.category}\n` +
      `📍 *Location:* ${locStr}\n` +
      `🔢 *Quantity:* ${extracted.quantity} unit(s)\n` +
      `📝 *Specs:* ${extracted.specs}\n\n` +
      `📡 *Broadcast Lead Radar:* Ready to alert matching buyers as soon as you confirm!\n\n` +
      `_Please confirm if these details are correct or click Edit to update before saving:_`;

    const inlineKeyboard = new InlineKeyboard()
      .text('✅ Confirm & Save Inventory', 'inv_confirm')
      .text('✏️ Edit Item', 'inv_edit')
      .row()
      .text('❌ Cancel', 'inv_cancel');

    return {
      extracted,
      reviewText,
      inlineKeyboard,
    };
  }

  /**
   * Confirms and publishes a pending inventory draft directly to Firestore products collection and triggers Broadcast Lead Radar alerts!
   */
  public async confirmAndPublishDraft(
    userId: string | number,
    botApi?: any
  ): Promise<{
    success: boolean;
    publishedText: string;
    savedProduct?: ProductDoc;
    radarCount?: number;
  }> {
    const key = String(userId);
    const draft = this.pendingInventoryDrafts.get(key);

    if (!draft) {
      return {
        success: false,
        publishedText: `⚠️ *No Active Inventory Draft Found.*\n\nSimply send a voice note, photo, or text message describing your stock to create a new draft!`,
      };
    }

    const { extracted, photoUrl } = draft;
    const merchant = await this.getMerchant(key);
    const bizName = merchant?.businessName || `Merchant ${key.slice(-4)}`;
    const wa = merchant?.whatsapp || key;
    const state = extracted.state || merchant?.state || 'Lagos';
    const city = extracted.city || merchant?.city || 'Ikeja';

    // 1. Save directly to Firestore primary database ('products' collection)
    const savedProduct = await this.saveProductListing({
      userId,
      businessName: bizName,
      whatsapp: wa,
      state,
      city,
      listingType: 'Product',
      category: extracted.category,
      product: extracted.product,
      price: extracted.price,
      negotiation: extracted.negotiable,
      quantity: extracted.quantity,
      specs: extracted.specs,
      photoUrl,
    });

    // 2. Trigger Broadcast Lead Radar alerts to Telegram buyers
    const radarResult = await this.triggerBroadcastLeadRadar(savedProduct, botApi);

    // 3. Clear draft from memory
    this.pendingInventoryDrafts.delete(key);

    const radarNote = radarResult.buyersNotifiedCount > 0
      ? `\n\n⚡ *Broadcast Lead Radar Dispatched:* Notified *${radarResult.buyersNotifiedCount} buyer(s)* who previously searched for "${extracted.product}"!`
      : `\n\n📡 *Broadcast Lead Radar Active:* We are actively monitoring buyers searching for "${extracted.product}".`;

    const publishedText =
      `🎉 *AI INVENTORY SYNC PUBLISHED!* 🎉\n\n` +
      `Your inventory has been verified and saved directly to your Floate store catalog in Firestore:\n\n` +
      `📦 *Product:* ${extracted.product}\n` +
      `💰 *Price:* ${extracted.price}\n` +
      `📂 *Category:* ${extracted.category}\n` +
      `📍 *Location:* ${city}, ${state}\n` +
      `🔢 *Quantity:* ${extracted.quantity} unit(s)\n` +
      `📝 *Specs:* ${extracted.specs}` +
      radarNote;

    return {
      success: true,
      publishedText,
      savedProduct,
      radarCount: radarResult.buyersNotifiedCount,
    };
  }

  /**
   * Cancels a pending inventory draft
   */
  public cancelDraft(userId: string | number): boolean {
    const key = String(userId);
    return this.pendingInventoryDrafts.delete(key);
  }

  /**
   * Legacy wrapper for backward compatibility
   */
  public async processVoiceOrPhotoInventorySync(
    userId: string | number,
    textOrCaption: string,
    photoUrl?: string,
    botApi?: any
  ): Promise<{
    extracted: ExtractedInventoryData;
    savedProduct: ProductDoc;
    radarCount: number;
    formattedReply: string;
  }> {
    const { extracted } = await this.prepareInventoryDraft(userId, textOrCaption, photoUrl);
    const pub = await this.confirmAndPublishDraft(userId, botApi);
    return {
      extracted,
      savedProduct: pub.savedProduct!,
      radarCount: pub.radarCount || 0,
      formattedReply: pub.publishedText,
    };
  }

  /**
   * Save a merchant submitted for manual compliance review (PENDING_REVIEW)
   */
  public async savePendingReviewMerchant(merchant: Omit<PendingReviewMerchantDoc, 'createdAt' | 'updatedAt'>): Promise<PendingReviewMerchantDoc> {
    const docId = String(merchant.id || merchant.whatsapp || `pending_${Date.now()}`);
    const pendingDoc: PendingReviewMerchantDoc = {
      ...merchant,
      id: docId,
      status: 'PENDING_REVIEW',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      const pendingRef = doc(db, 'pending_merchants', docId);
      await setDoc(pendingRef, this.sanitizeForFirestore(pendingDoc));
      console.log(`[Firestore] Saved pending review merchant ${docId} (${merchant.businessName})`);
    } catch (err) {
      console.error(`[Firestore] Error saving pending review merchant ${docId}:`, err);
    }

    return pendingDoc;
  }

  /**
   * Get a pending review merchant by ID or WhatsApp
   */
  public async getPendingReviewMerchant(idOrPhone: string): Promise<PendingReviewMerchantDoc | null> {
    try {
      const cleanKey = String(idOrPhone).trim();
      const ref = doc(db, 'pending_merchants', cleanKey);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        return snap.data() as PendingReviewMerchantDoc;
      }

      // Search collection if document ID not exact match
      const pendingCol = collection(db, 'pending_merchants');
      const qSnap = await getDocs(query(pendingCol));
      for (const pDoc of qSnap.docs) {
        const data = pDoc.data() as PendingReviewMerchantDoc;
        if (
          pDoc.id === cleanKey ||
          data.whatsapp === cleanKey ||
          normalizePhone(data.whatsapp) === normalizePhone(cleanKey) ||
          data.businessName?.toLowerCase() === cleanKey.toLowerCase()
        ) {
          return data;
        }
      }
    } catch (err) {
      console.error(`[Firestore] Error getting pending review merchant ${idOrPhone}:`, err);
    }
    return null;
  }

  /**
   * Update pending review merchant status
   */
  public async updatePendingReviewStatus(
    idOrPhone: string,
    status: 'APPROVED' | 'REJECTED'
  ): Promise<boolean> {
    try {
      const pending = await this.getPendingReviewMerchant(idOrPhone);
      if (!pending) return false;

      const ref = doc(db, 'pending_merchants', pending.id);
      await updateDoc(ref, this.sanitizeForFirestore({
        status,
        updatedAt: new Date().toISOString(),
      }));
      return true;
    } catch (err) {
      console.error(`[Firestore] Error updating pending review status for ${idOrPhone}:`, err);
      return false;
    }
  }

  /**
   * Deletes a merchant and associated products matching merchantId or query string (e.g. '2345')
   */
  public async deleteMerchant(merchantIdOrQuery: string): Promise<{ deletedMerchant: boolean; deletedProductsCount: number }> {
    let deletedMerchant = false;
    let deletedProductsCount = 0;
    try {
      const queryKey = merchantIdOrQuery.trim().toLowerCase();
      if (!queryKey) return { deletedMerchant, deletedProductsCount };

      const { deleteDoc, doc: firestoreDoc } = await import('firebase/firestore');

      // 1. Check merchants collection
      const merchantsRef = collection(db, 'merchants');
      const qSnap = await getDocs(query(merchantsRef));
      
      for (const mDoc of qSnap.docs) {
        const data = mDoc.data() as MerchantDoc;
        const docId = mDoc.id.toLowerCase();
        if (
          docId === queryKey ||
          docId.includes(queryKey) ||
          (data.id && String(data.id).toLowerCase().includes(queryKey)) ||
          (data.whatsapp && String(data.whatsapp).toLowerCase().includes(queryKey)) ||
          (data.businessName && data.businessName.toLowerCase().includes(queryKey))
        ) {
          await deleteDoc(firestoreDoc(db, 'merchants', mDoc.id));
          deletedMerchant = true;
          console.log(`[Firestore] Deleted merchant document ${mDoc.id}`);
        }
      }

      // 2. Check products collection
      const productsRef = collection(db, 'products');
      const pSnap = await getDocs(query(productsRef));
      
      for (const pDoc of pSnap.docs) {
        const data = pDoc.data() as ProductDoc;
        const pId = pDoc.id.toLowerCase();
        if (
          pId === queryKey ||
          pId.includes(queryKey) ||
          (data.merchantId && String(data.merchantId).toLowerCase().includes(queryKey)) ||
          (data.whatsapp && String(data.whatsapp).toLowerCase().includes(queryKey)) ||
          (data.businessName && data.businessName.toLowerCase().includes(queryKey))
        ) {
          await deleteDoc(firestoreDoc(db, 'products', pDoc.id));
          deletedProductsCount++;
          console.log(`[Firestore] Deleted product document ${pDoc.id}`);
        }
      }
    } catch (err) {
      console.error(`[Firestore Notice] Delete merchant check for "${merchantIdOrQuery}":`, err);
    }
    return { deletedMerchant, deletedProductsCount };
  }

  /**
   * Get all products for a specific merchant
   */
  public async getProductsByMerchant(merchantIdOrPhone: string): Promise<ProductDoc[]> {
    try {
      const cleanKey = String(merchantIdOrPhone).trim().toLowerCase();
      const normPhone = normalizePhone(merchantIdOrPhone);
      const productsRef = collection(db, 'products');
      const pSnap = await getDocs(query(productsRef));
      const list: ProductDoc[] = [];

      for (const pDoc of pSnap.docs) {
        const data = pDoc.data() as ProductDoc;
        const mId = (data.merchantId || '').toLowerCase();
        const pPhone = normalizePhone(data.whatsapp || '');
        if (
          mId === cleanKey ||
          mId.includes(cleanKey) ||
          (normPhone && pPhone === normPhone) ||
          (cleanKey && data.businessName?.toLowerCase() === cleanKey)
        ) {
          list.push({ ...data, id: pDoc.id });
        }
      }
      return list;
    } catch (err) {
      console.error(`[Firestore] Error fetching products for merchant ${merchantIdOrPhone}:`, err);
      return [];
    }
  }

  /**
   * Update a product by its ID
   */
  public async updateProduct(productId: string, updates: Partial<ProductDoc>): Promise<boolean> {
    try {
      const pRef = doc(db, 'products', productId);
      const snap = await getDoc(pRef);
      if (!snap.exists()) return false;

      const sanitizedUpdates = this.sanitizeForFirestore({
        ...updates,
        updatedAt: new Date().toISOString(),
      });
      await updateDoc(pRef, sanitizedUpdates);
      return true;
    } catch (err) {
      console.error(`[Firestore] Error updating product ${productId}:`, err);
      return false;
    }
  }

  /**
   * Delete a single product by ID
   */
  public async deleteProductById(productId: string): Promise<boolean> {
    try {
      const { deleteDoc, doc: firestoreDoc } = await import('firebase/firestore');
      const pRef = firestoreDoc(db, 'products', productId);
      await deleteDoc(pRef);
      return true;
    } catch (err) {
      console.error(`[Firestore] Error deleting product ${productId}:`, err);
      return false;
    }
  }

  /**
   * Get vendor performance stats
   */
  public async getMerchantStats(merchantIdOrPhone: string): Promise<{
    appearances: number;
    leadsGenerated: number;
    productCount: number;
    balance: number;
    registeredSince: string;
    isVerified: boolean;
    businessName: string;
  }> {
    const merchant = await this.getMerchant(merchantIdOrPhone);
    const products = await this.getProductsByMerchant(merchantIdOrPhone);
    
    // Count leads
    let leadsCount = 0;
    try {
      const leadsCol = collection(db, 'leads');
      const lSnap = await getDocs(query(leadsCol));
      const cleanPhone = normalizePhone(merchantIdOrPhone);
      for (const lDoc of lSnap.docs) {
        const lead = lDoc.data() as LeadDoc;
        if (
          lead.merchantId === merchant?.id ||
          (cleanPhone && normalizePhone(lead.merchantWhatsapp) === cleanPhone)
        ) {
          leadsCount++;
        }
      }
    } catch (e) {
      console.warn('[Firestore] Notice fetching lead count:', e);
    }

    return {
      appearances: Math.max(12, products.length * 4 + leadsCount * 3),
      leadsGenerated: leadsCount,
      productCount: products.length,
      balance: merchant?.credit_balance ?? 1000,
      registeredSince: merchant?.claimDate || 'Jan 2026',
      isVerified: merchant?.isVerified ?? true,
      businessName: merchant?.businessName || 'Your Business',
    };
  }

  /**
   * Records a 3-step qualified lead from WhatsApp to Firestore
   */
  public async recordWhatsAppLead(params: {
    buyerPhone: string;
    buyerName?: string;
    merchantId: string;
    merchantName: string;
    merchantWhatsapp: string;
    item: string;
    orderVolume: 'Retail' | 'Wholesale';
    fulfillment: 'Shop Visit' | 'Local City Delivery' | 'Interstate Waybill';
    buyerLocation: string;
  }): Promise<LeadDoc | null> {
    try {
      const leadId = `lead-wa-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const leadRefCode = `FLT-${Math.floor(100000 + Math.random() * 900000)}`;
      const cleanBizPhone = normalizePhone(params.merchantWhatsapp).replace(/^0/, '234');
      const waLink = `https://wa.me/${cleanBizPhone}?text=${encodeURIComponent(`HI ${params.merchantName.toUpperCase()}, I found you on FLOATE.`)}`;

      const lead: LeadDoc = {
        id: leadId,
        ref: leadRefCode,
        buyerId: params.buyerPhone,
        buyerUsername: params.buyerName || params.buyerPhone,
        merchantId: params.merchantId || '',
        merchantName: params.merchantName || '',
        merchantWhatsapp: params.merchantWhatsapp || '',
        item: params.item || 'In-Stock Item',
        location: params.buyerLocation || 'Nigeria',
        cost: 0,
        waLink,
        timestamp: new Date().toISOString(),
      };

      const leadsCol = collection(db, 'leads');
      await setDoc(doc(leadsCol, leadId), this.sanitizeForFirestore(lead));
      return lead;
    } catch (err) {
      console.error('[Firestore] Error saving WhatsApp lead:', err);
      return null;
    }
  }
}

export const firestoreDb = new FirestoreService();

