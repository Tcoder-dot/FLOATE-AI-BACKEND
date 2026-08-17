import React, { useState } from 'react';
import { Bot, Terminal, Code2, Globe, Store, ExternalLink } from 'lucide-react';
import { BotTester } from './components/BotTester';
import { ApiDocs } from './components/ApiDocs';
import { WebSearchDemo } from './components/WebSearchDemo';

export default function App() {
  const [activeTab, setActiveTab] = useState<'search' | 'tester' | 'docs'>('search');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans antialiased selection:bg-sky-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  Telegram Bot & Search API Engine
                  <span className="text-[10px] font-mono bg-sky-950 text-sky-300 border border-sky-800 px-2 py-0.5 rounded-full font-medium">
                    GramMY + Express API
                  </span>
                </h1>
                <p className="text-xs text-slate-400">floate.xyz Search API, Telegram Qualification & Webhook Engine</p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto justify-end">
            <button
              onClick={() => setActiveTab('search')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                activeTab === 'search'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              Web Search API
            </button>
            <button
              onClick={() => setActiveTab('tester')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                activeTab === 'tester'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              Bot Simulator
            </button>
            <button
              onClick={() => setActiveTab('docs')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                activeTab === 'docs'
                  ? 'bg-sky-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              API Docs
            </button>

            <a
              href="https://t.me/Floatebusinessbot?start=register_business"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all shadow-sm active:scale-95"
            >
              <Store className="w-3.5 h-3.5" />
              Register Business
              <ExternalLink className="w-3 h-3 opacity-80" />
            </a>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'search' && <WebSearchDemo />}
        {activeTab === 'tester' && <BotTester />}
        {activeTab === 'docs' && <ApiDocs />}
      </main>
    </div>
  );
}
