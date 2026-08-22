export interface WhatsAppVendorRegDraft {
  step:
    | 'STEP_1_NAME'
    | 'STEP_2_BIZ'
    | 'STEP_3_LOCATION'
    | 'STEP_4_PRODUCTS'
    | 'STEP_5_PHOTO'
    | 'STEP_6_CONFIRM';
  ownerFullName?: string;
  businessName?: string;
  cacNumber?: string;
  marketHub?: string;
  shopAddress?: string;
  category?: string;
  productsDescription?: string;
  priceRange?: string;
  photoVerified?: boolean;
  photoMediaId?: string;
  updatedAt: string;
}

export interface WhatsAppClaimDraft {
  step: 'AWAITING_BIZ_NAME' | 'AWAITING_OTP';
  listingId?: string;
  businessName?: string;
  registeredPhone?: string;
  otpCode?: string;
  otpExpiresAt?: number;
  updatedAt: string;
}

export interface WhatsAppReportDraft {
  step: 'AWAITING_DETAILS';
  vendorId?: string;
  vendorName?: string;
  vendorPhone?: string;
  updatedAt: string;
}

export interface WhatsAppVendorAddDraft {
  step: 'NAME' | 'PRICE' | 'DESC' | 'CONFIRM';
  productName?: string;
  price?: string;
  description?: string;
  category?: string;
  updatedAt: string;
}

export interface WhatsAppVendorEditDraft {
  step: 'SELECT' | 'ACTION' | 'VALUE';
  selectedProductId?: string;
  selectedProductName?: string;
  action?: 'PRICE' | 'NAME' | 'DELETE';
  updatedAt: string;
}

export interface RelayMessage {
  senderRole: 'BUYER' | 'VENDOR';
  senderPhone: string;
  text: string;
  timestamp: string;
}

export interface RelaySession {
  id: string;
  buyerPhone: string;
  buyerName: string;
  vendorPhone: string;
  vendorName: string;
  vendorId: string;
  item: string;
  price?: string;
  status: 'ACTIVE' | 'AGREEMENT_PENDING' | 'ENDED';
  messages: RelayMessage[];
  agreementDetails?: {
    item: string;
    agreedPrice: string;
    terms?: string;
    detectedAt: string;
  };
  paymentOptionChosen?: 'SAFEPAY' | 'DIRECT';
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppSearchState {
  lastQuery?: string;
  cleanProduct?: string;
  location?: string;
  category?: string;
  allMatchingListings?: any[];
  pageIndex: number;
  updatedAt: string;
}

export interface WhatsAppUserSessionState {
  state:
    | 'IDLE'
    | 'RELAY_CHAT'
    | 'AWAITING_ROLE_SELECTION'
    | 'AWAITING_PRIMARY_LOCATION'
    | 'AWAITING_LOCATION_CHANGE'
    | 'AWAITING_SAVE_CONTACT'
    | 'REG_STEP_1_BIZ_NAME'
    | 'REG_STEP_2_CATEGORY'
    | 'REG_STEP_3_LOCATION'
    | 'REG_STEP_4_PRODUCT'
    | 'QUALIFYING_VOLUME'
    | 'QUALIFYING_FULFILLMENT'
    | 'QUALIFYING_LOCATION'
    | 'REG_ONBOARDING'
    | 'CLAIM_PROCESS'
    | 'REPORT_PROCESS'
    | 'VENDOR_PORTAL'
    | 'VENDOR_ADD_PRODUCT'
    | 'VENDOR_EDIT_PRODUCTS'
    | 'VENDOR_DELETE_CONFIRM';
  activeRelayId?: string;
  activeVendorId?: string;
  activeVendorName?: string;
  activeVendorPhone?: string;
  activeBuyerPhone?: string;
  activeItem?: string;
  orderVolume?: 'Retail' | 'Wholesale';
  fulfillment?: 'Shop Visit' | 'Local City Delivery' | 'Interstate Waybill';
  buyerLocation?: string;
  searchState?: WhatsAppSearchState;
  regDraft?: WhatsAppVendorRegDraft;
  claimDraft?: WhatsAppClaimDraft;
  reportDraft?: WhatsAppReportDraft;
  vendorAddDraft?: WhatsAppVendorAddDraft;
  vendorEditDraft?: WhatsAppVendorEditDraft;
  hasReceivedContactCard?: boolean;
  hasSeenSaveTip?: boolean;
  pendingInitialText?: string;
  pendingIntent?: {
    action: 'REGISTER_VENDOR' | 'CONNECT_VENDOR' | 'SEARCH' | 'GREETING';
    payload?: any;
  };
  updatedAt: string;
}

// In-memory active sessions store for ultra-fast conversational state routing
const waSessions = new Map<string, WhatsAppUserSessionState>();

// In-memory active relay sessions store
const activeRelaySessions = new Map<string, RelaySession>();
const phoneToRelayIdMap = new Map<string, string>();

export function getActiveRelaySession(phone: string): RelaySession | null {
  const clean = phone.replace(/\D/g, '');
  const relayId = phoneToRelayIdMap.get(clean);
  if (!relayId) return null;
  const session = activeRelaySessions.get(relayId);
  if (!session || session.status === 'ENDED') {
    phoneToRelayIdMap.delete(clean);
    return null;
  }
  return session;
}

export function saveRelaySession(session: RelaySession): void {
  activeRelaySessions.set(session.id, session);
  const cleanBuyer = session.buyerPhone.replace(/\D/g, '');
  const cleanVendor = session.vendorPhone.replace(/\D/g, '');
  if (session.status !== 'ENDED') {
    phoneToRelayIdMap.set(cleanBuyer, session.id);
    phoneToRelayIdMap.set(cleanVendor, session.id);
  } else {
    phoneToRelayIdMap.delete(cleanBuyer);
    phoneToRelayIdMap.delete(cleanVendor);
  }
}

export function endRelaySession(sessionId: string): RelaySession | null {
  const session = activeRelaySessions.get(sessionId);
  if (!session) return null;
  session.status = 'ENDED';
  session.updatedAt = new Date().toISOString();
  saveRelaySession(session);
  return session;
}

export function getWhatsAppSession(phone: string): WhatsAppUserSessionState {
  const clean = phone.replace(/\D/g, '');
  if (!waSessions.has(clean)) {
    waSessions.set(clean, {
      state: 'IDLE',
      hasSeenSaveTip: false,
      updatedAt: new Date().toISOString(),
    });
  }
  return waSessions.get(clean)!;
}

export function updateWhatsAppSession(
  phone: string,
  update: Partial<WhatsAppUserSessionState>
): WhatsAppUserSessionState {
  const clean = phone.replace(/\D/g, '');
  const current = getWhatsAppSession(clean);
  const updated: WhatsAppUserSessionState = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  waSessions.set(clean, updated);
  return updated;
}

export function resetWhatsAppSession(phone: string): void {
  const clean = phone.replace(/\D/g, '');
  const prev = waSessions.get(clean);
  waSessions.set(clean, {
    state: 'IDLE',
    hasSeenSaveTip: prev?.hasSeenSaveTip ?? false,
    updatedAt: new Date().toISOString(),
  });
}
