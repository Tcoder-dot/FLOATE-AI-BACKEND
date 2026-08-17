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
    | 'AWAITING_SAVE_CONTACT'
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
  activeVendorId?: string;
  activeVendorName?: string;
  activeVendorPhone?: string;
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
  pendingIntent?: {
    action: 'REGISTER_VENDOR' | 'CONNECT_VENDOR' | 'SEARCH' | 'GREETING';
    payload?: any;
  };
  updatedAt: string;
}

// In-memory active sessions store for ultra-fast conversational state routing
const waSessions = new Map<string, WhatsAppUserSessionState>();

export function getWhatsAppSession(phone: string): WhatsAppUserSessionState {
  const clean = phone.replace(/\D/g, '');
  if (!waSessions.has(clean)) {
    waSessions.set(clean, {
      state: 'IDLE',
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
  waSessions.set(clean, {
    state: 'IDLE',
    updatedAt: new Date().toISOString(),
  });
}
