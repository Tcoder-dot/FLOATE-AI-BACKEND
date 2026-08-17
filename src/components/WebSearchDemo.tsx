import React, { useState } from 'react';
import { Search, Sparkles, ShoppingBag, MapPin, Tag, ExternalLink, ShieldCheck, Clock, Loader2, AlertCircle, ArrowRight, Trash2, Store, Bot, Layers, Send } from 'lucide-react';

interface SearchResult {
  id: string;
  businessName: string;
  category: string;
  product: string;
  price: string;
  location: string;
  isVerified: boolean;
  isHighlyRecommended?: boolean;
  identityVerified?: boolean;
  leadDeepLink: string;
  telegramDeepLink?: string;
  profileImageUrl?: string;
  productImages?: string[];
}

export function WebSearchDemo() {
  const [query, setQuery] = useState('footwear');
  const [location, setLocation] = useState('');
  const [budget, setBudget] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchTimeMs, setSearchTimeMs] = useState<number | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [results, setResults] = useState<SearchResult[]>([]);
  const [exactMatches, setExactMatches] = useState<SearchResult[]>([]);
  const [categoryMatches, setCategoryMatches] = useState<SearchResult[]>([]);
  const [moreBusinessesDeepLink, setMoreBusinessesDeepLink] = useState<string | null>(null);

  // Deletion state
  const [deletingMerchant, setDeletingMerchant] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);

  const handleSearch = async (overrideQuery?: string) => {
    const q = overrideQuery !== undefined ? overrideQuery : query;
    if (!q.trim()) return;

    // Reset state before firing request - NEVER set results to empty without setting loading to true!
    setLoading(true);
    setError(null);
    setHasSearched(false);
    const start = performance.now();

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'floate_live_sk_7f8a92b3c4e5d6',
        },
        body: JSON.stringify({
          query: q,
          location: location || undefined,
          budget: budget || undefined,
        }),
      });

      const data = await response.json();
      const elapsed = Math.round(performance.now() - start);
      setSearchTimeMs(elapsed);

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Search request failed');
      }

      setResults(data.results || []);
      setExactMatches(data.exactMatches || []);
      setCategoryMatches(data.categoryMatches || []);

      if (data.moreBusinessesDeepLink) {
        setMoreBusinessesDeepLink(data.moreBusinessesDeepLink);
      } else {
        const cleanSlug = q.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const locSlug = location ? `_in_${location.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}` : '';
        setMoreBusinessesDeepLink(`https://t.me/Floatebusinessbot?start=search_${cleanSlug}${locSlug}`);
      }

      setHasSearched(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch search results from server.');
      setResults([]);
      setExactMatches([]);
      setCategoryMatches([]);
      setMoreBusinessesDeepLink(null);
    } finally {
      // ONLY turn off loading after data is completely updated to prevent 'no match' flash!
      setLoading(false);
    }
  };

  const handleDeleteMerchant2345 = async () => {
    setDeletingMerchant(true);
    setDeleteMessage(null);
    try {
      const res = await fetch('/api/admin/delete-merchant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantId: '2345' }),
      });
      const data = await res.json();
      if (data.success) {
        setDeleteMessage('✅ Merchant 2345 successfully removed from Google Sheets and Firestore database!');
        // Refresh search if active
        if (hasSearched) handleSearch();
      } else {
        setDeleteMessage(`⚠️ Delete failed: ${data.error}`);
      }
    } catch (err: any) {
      setDeleteMessage(`⚠️ Delete error: ${err?.message}`);
    } finally {
      setDeletingMerchant(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search Header Banner */}
      <div className="bg-gradient-to-r from-sky-950/80 via-slate-900 to-indigo-950/80 border border-sky-800/50 rounded-2xl p-6 shadow-lg">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <span className="text-[11px] font-mono bg-sky-900/60 text-sky-300 border border-sky-700/80 px-2.5 py-0.5 rounded-full font-semibold uppercase tracking-wider">
              Website Integration
            </span>
            <h2 className="text-xl font-bold text-slate-100 mt-2 flex items-center gap-2">
              <Search className="w-5 h-5 text-sky-400" />
              Floate.xyz Web Search API Engine
            </h2>
            <p className="text-xs text-slate-300 mt-1 max-w-2xl">
              Live relevance filtering, sub-second query latency, and smooth loading states without premature "no match" visual flashes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <a
              href="https://wa.me/2348000000000?text=REGISTER_BUSINESS"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center gap-2 transition-all shadow-md hover:shadow-emerald-900/30 active:scale-95"
            >
              <Store className="w-4 h-4" />
              Register on WhatsApp
              <ExternalLink className="w-3.5 h-3.5 opacity-80" />
            </a>

            <a
              href="https://t.me/Floatebusinessbot?start=register_business"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2.5 bg-sky-950/80 hover:bg-sky-900 border border-sky-800 text-sky-200 text-xs font-medium rounded-xl flex items-center gap-2 transition-all"
            >
              <Bot className="w-4 h-4 text-sky-400" />
              Telegram Bot
              <ExternalLink className="w-3.5 h-3.5 opacity-80" />
            </a>

            <button
              onClick={handleDeleteMerchant2345}
              disabled={deletingMerchant}
              className="px-3.5 py-2.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-800 text-rose-200 text-xs font-medium rounded-xl flex items-center gap-2 transition-all"
            >
              {deletingMerchant ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Delete 2345
            </button>
          </div>
        </div>

        {deleteMessage && (
          <div className="mt-3 p-2.5 bg-slate-950/80 border border-slate-800 rounded-xl text-xs font-mono text-emerald-400">
            {deleteMessage}
          </div>
        )}
      </div>

      {/* Interactive Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
        <div className="flex items-center gap-2 text-xs font-mono text-slate-400 uppercase tracking-wider">
          <Sparkles className="w-4 h-4 text-sky-400" />
          Test Web Search Query:
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6 relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search product or service (e.g., footwear, video editor, lawyer)..."
              className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 text-slate-100 text-sm rounded-xl pl-10 pr-4 py-3 outline-none"
            />
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
          </div>

          <div className="md:col-span-3">
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Location (e.g., Onitsha)"
              className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 text-slate-100 text-sm rounded-xl px-3.5 py-3 outline-none"
            />
          </div>

          <div className="md:col-span-3">
            <button
              onClick={() => handleSearch()}
              disabled={loading || !query.trim()}
              className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl py-3 px-4 transition-all flex items-center justify-center gap-2 shadow-md"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  Run Search
                </>
              )}
            </button>
          </div>
        </div>

        {/* Quick Sample Presets */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80 text-xs">
          <span className="text-slate-500 font-mono text-[11px]">Quick Tests:</span>
          {[
            { label: '👠 "footwear"', q: 'footwear' },
            { label: '🎬 "video editor"', q: 'video editor' },
            { label: '👞 "leather slippers"', q: 'leather slippers' },
            { label: '⚖️ "lawyer"', q: 'lawyer' },
            { label: '💻 "laptops"', q: 'laptops' },
          ].map((preset) => (
            <button
              key={preset.q}
              onClick={() => {
                setQuery(preset.q);
                handleSearch(preset.q);
              }}
              disabled={loading}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-sky-950 hover:text-sky-300 border border-slate-700 text-slate-300 transition-colors font-mono"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results View Section */}
      <div className="space-y-4">
        {/* Latency & Status Header */}
        {hasSearched && !loading && (
          <div className="flex items-center justify-between text-xs text-slate-400 px-1 font-mono">
            <span>
              Found <strong className="text-slate-100">{results.length}</strong> relevant business match(es)
            </span>
            {searchTimeMs !== null && (
              <span className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-lg text-emerald-400">
                <Clock className="w-3 h-3" />
                API Latency: {searchTimeMs} ms
              </span>
            )}
          </div>
        )}

        {/* 1. Loading State Shimmer (Prevents "no match" flash!) */}
        {loading && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-3 text-sky-400 text-xs font-mono">
              <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
              Executing relevance matching and location filtering on server...
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2].map((i) => (
                <div key={i} className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 space-y-3 animate-pulse">
                  <div className="h-4 bg-slate-800 rounded w-2/3"></div>
                  <div className="h-3 bg-slate-800/60 rounded w-1/2"></div>
                  <div className="h-3 bg-slate-800/40 rounded w-1/3"></div>
                  <div className="h-8 bg-sky-950/40 border border-sky-900/30 rounded-lg w-full mt-2"></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2. Error State */}
        {error && !loading && (
          <div className="bg-rose-950/40 border border-rose-900/60 rounded-2xl p-4 text-xs font-mono text-rose-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            {error}
          </div>
        )}

        {/* 3. True "No Match" State (ONLY shown when loading is false AND results array is truly empty) */}
        {!loading && hasSearched && results.length === 0 && !error && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto text-slate-400">
              <Search className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-slate-200">No matching business listings found</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              We couldn't find any verified seller for "{query}". Try searching for broader terms like "shoes", "laptops", "services", or "video".
            </p>
          </div>
        )}

        {/* 4. Results Display List (Limited to prevent UI clutter) */}
        {!loading && results.length > 0 && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">
                Top Recommended Verified Businesses ({Math.min(results.length, 4)} of {results.length} shown)
              </span>
              {moreBusinessesDeepLink && (
                <a
                  href={moreBusinessesDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-sky-400 hover:text-sky-300 flex items-center gap-1 transition-colors"
                >
                  <Bot className="w-3.5 h-3.5" />
                  View All in Telegram
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {results.slice(0, 4).map((biz) => {
                const deepLinkUrl = biz.telegramDeepLink || biz.leadDeepLink || 'https://t.me/Floatebusinessbot';
                return (
                  <div
                    key={biz.id}
                    className="bg-slate-900 hover:border-sky-700/80 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between transition-all shadow-md group"
                  >
                    <div className="space-y-3">
                      {/* Header with Profile Image and Badges */}
                      <div className="flex items-start gap-3">
                        {biz.profileImageUrl ? (
                          <img
                            src={biz.profileImageUrl}
                            alt={biz.businessName}
                            className="w-12 h-12 rounded-xl object-cover border border-slate-700 shrink-0 bg-slate-800"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-sky-900 to-indigo-900 border border-sky-700 flex items-center justify-center text-sky-200 font-bold text-base shrink-0">
                            {biz.businessName.charAt(0).toUpperCase()}
                          </div>
                        )}

                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-bold text-slate-100 text-sm group-hover:text-sky-300 transition-colors truncate">
                              {biz.businessName}
                            </h3>
                            <span className="text-xs font-mono font-bold text-sky-400 bg-sky-950/80 border border-sky-800 px-2 py-0.5 rounded-lg shrink-0">
                              {biz.price}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            {biz.isHighlyRecommended && (
                              <span className="text-[10px] font-mono bg-amber-950/90 text-amber-300 border border-amber-700/80 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5 shadow-sm">
                                <Sparkles className="w-3 h-3 text-amber-400 fill-amber-400" />
                                Top Rated Vendor
                              </span>
                            )}
                            {biz.identityVerified && (
                              <span className="text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800/80 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                                Identity Verified
                              </span>
                            )}
                            {biz.isVerified && !biz.identityVerified && (
                              <span className="text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800/80 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                                Verified
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="text-xs text-slate-300 space-y-1 pt-1 border-t border-slate-800/60">
                        <div className="flex items-center gap-1.5 text-slate-300 font-medium">
                          <ShoppingBag className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          Product / Item: <span className="text-slate-100 font-semibold">{biz.product}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-slate-400">
                          <Tag className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          Category: {biz.category}
                        </div>
                        <div className="flex items-center gap-1.5 text-slate-400">
                          <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          Location: {biz.location}
                        </div>
                      </div>

                      {/* Product Photos Gallery Preview */}
                      {biz.productImages && biz.productImages.length > 0 && (
                        <div className="space-y-1 pt-1">
                          <span className="text-[11px] font-mono text-slate-400">Product Photos:</span>
                          <div className="flex items-center gap-2 overflow-x-auto pb-1">
                            {biz.productImages.map((imgUrl, idx) => (
                              <img
                                key={idx}
                                src={imgUrl}
                                alt={`${biz.product} photo ${idx + 1}`}
                                className="w-14 h-14 rounded-lg object-cover border border-slate-700 bg-slate-800 shrink-0"
                                referrerPolicy="no-referrer"
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Lead Qualification Deep Links (WhatsApp + Telegram) */}
                    <div className="mt-4 pt-3 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <a
                        href={biz.whatsappDeepLink || `https://wa.me/2348000000000?text=CONNECT_VENDOR_${encodeURIComponent(biz.id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-2 px-3 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                      >
                        <ShoppingBag className="w-3.5 h-3.5" />
                        Chat on WhatsApp
                        <ExternalLink className="w-3 h-3 opacity-80" />
                      </a>

                      <a
                        href={deepLinkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-2 px-3 bg-sky-600/20 hover:bg-sky-600 text-sky-300 hover:text-white border border-sky-500/40 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                      >
                        <Bot className="w-3.5 h-3.5 text-sky-400" />
                        Telegram
                        <ExternalLink className="w-3 h-3 opacity-80" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* MORE BUSINESSES CALL TO ACTION (Deep links to WhatsApp & Telegram Bot with search query context) */}
            <div className="bg-gradient-to-r from-sky-950/80 via-slate-900 to-indigo-950/80 border-2 border-sky-600/50 rounded-2xl p-6 shadow-xl flex flex-col sm:flex-row items-center justify-between gap-5 text-center sm:text-left">
              <div className="space-y-1.5 max-w-xl">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold tracking-wide uppercase font-mono">
                  <Sparkles className="w-3.5 h-3.5" />
                  Explore Verified Catalog
                </div>
                <h4 className="text-base font-bold text-slate-100">
                  Looking for more options or specialized vendors?
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Connect on WhatsApp or Telegram to search the full nationwide network for <strong className="text-sky-300">"{query}"</strong> with direct merchant price quotes and waybill verification.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-2.5 w-full sm:w-auto shrink-0">
                <a
                  href={`https://wa.me/2348000000000?text=SEARCH_${encodeURIComponent(query.toLowerCase().replace(/[^a-z0-9]+/g, '_'))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto px-5 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-lg hover:shadow-emerald-900/30 flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <ShoppingBag className="w-4 h-4" />
                  <span>MORE ON WHATSAPP</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>

                <a
                  href={moreBusinessesDeepLink || `https://t.me/Floatebusinessbot?start=search_${encodeURIComponent(query.toLowerCase().replace(/[^a-z0-9]+/g, '_'))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto px-5 py-3 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs rounded-xl shadow-lg hover:shadow-sky-900/30 flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <Bot className="w-4 h-4" />
                  <span>TELEGRAM</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
