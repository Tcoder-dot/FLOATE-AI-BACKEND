import React, { useState } from 'react';
import { Send, Bot as BotIcon, User, RefreshCw, Sparkles, CheckCircle2, AlertCircle, Terminal, Play } from 'lucide-react';

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  replyMarkup?: any;
  timestamp: string;
}

export function BotTester() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      sender: 'bot',
      text: '👋 Welcome to Telegram Bot Logic Tester!\n\nSend a command or text below to test your bot logic handlers.',
      replyMarkup: {
        inline_keyboard: [
          [{ text: '🤖 Ask AI', callback_data: 'cmd_ask_ai' }, { text: '📊 Bot Status', callback_data: 'cmd_status' }],
          [{ text: '❓ Help', callback_data: 'cmd_help' }, { text: '⚙️ Settings', callback_data: 'cmd_settings' }],
        ],
      },
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<string[]>(['[System] Bot Logic Tester ready.']);

  const sendMessage = async (textToSend?: string) => {
    const text = textToSend || input;
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/bot/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, firstName: 'Developer' }),
      });

      const data = await res.json();

      if (data.logs) {
        setLogs((prev) => [...prev, ...data.logs]);
      }

      if (data.replies && data.replies.length > 0) {
        data.replies.forEach((reply: any) => {
          const botMsg: ChatMessage = {
            id: (Date.now() + Math.random()).toString(),
            sender: 'bot',
            text: reply.text,
            replyMarkup: reply.replyMarkup,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          setMessages((prev) => [...prev, botMsg]);
        });
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            sender: 'bot',
            text: 'ℹ️ Handled silently without outgoing message response.',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: 'bot',
          text: `⚠️ Error executing bot handler: ${err?.message || 'Server error'}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleButtonClick = (actionText: string) => {
    sendMessage(actionText);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Telegram Chat Simulation */}
      <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col h-[650px] shadow-xl overflow-hidden">
        {/* Chat Header */}
        <div className="bg-slate-800/80 backdrop-blur px-5 py-3 border-b border-slate-700/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <BotIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100 text-sm">Telegram Bot Logic Handler</h3>
              <p className="text-xs text-sky-400 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                Webhook Handler Listening
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setMessages([]);
              setLogs(['[System] Chat log cleared.']);
            }}
            className="p-2 text-slate-400 hover:text-slate-200 transition-colors rounded-lg hover:bg-slate-800 text-xs flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>

        {/* Quick Commands Bar */}
        <div className="px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 flex items-center gap-2 overflow-x-auto text-xs">
          <span className="text-slate-400 font-mono text-[11px] uppercase tracking-wider whitespace-nowrap">Test Floate AI:</span>
          {['/start', '🎙️ Voice Note: Where can I get leather slippers in Onitsha 15k', '/claim', '/register', '/addproduct Men Sandals 8k', 'iPhone 13 200k Enugu', '/status'].map((cmd) => (
            <button
              key={cmd}
              onClick={() => handleButtonClick(cmd)}
              disabled={loading}
              className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-sky-950 hover:text-sky-300 hover:border-sky-700 border border-slate-700 text-slate-300 font-mono whitespace-nowrap transition-colors"
            >
              {cmd}
            </button>
          ))}
        </div>

        {/* Message Stream */}
        <div className="flex-1 p-5 overflow-y-auto space-y-4 bg-slate-950/40">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                  msg.sender === 'user'
                    ? 'bg-sky-600 text-white rounded-br-none'
                    : 'bg-slate-800 text-slate-100 border border-slate-700/80 rounded-bl-none'
                }`}
              >
                <div className="whitespace-pre-wrap font-sans">{msg.text}</div>

                {/* Render Inline Keyboards if present */}
                {msg.replyMarkup?.inline_keyboard && (
                  <div className="mt-3 pt-2 border-t border-slate-700/50 space-y-1.5">
                    {msg.replyMarkup.inline_keyboard.map((row: any[], rIdx: number) => (
                      <div key={rIdx} className="flex gap-1.5">
                        {row.map((btn: any, bIdx: number) => (
                          <button
                            key={bIdx}
                            onClick={() => handleButtonClick(btn.callback_data || btn.text)}
                            className="flex-1 py-1.5 px-3 bg-slate-700/70 hover:bg-sky-600/30 hover:border-sky-500 border border-slate-600 text-sky-300 hover:text-sky-200 text-xs font-medium rounded-lg transition-all text-center"
                          >
                            {btn.text}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[10px] opacity-60 text-right mt-1.5 font-mono">{msg.timestamp}</div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs bg-slate-800/50 p-3 rounded-xl w-max">
              <Sparkles className="w-4 h-4 animate-spin text-sky-400" />
              Processing Telegram handler logic...
            </div>
          )}
        </div>

        {/* Quick Test Presets */}
        <div className="px-4 py-2 bg-slate-900/80 border-t border-slate-800/80 flex flex-wrap gap-2 text-xs">
          <span className="text-slate-500 text-[11px] self-center font-mono mr-1">Quick Test:</span>
          <button
            onClick={() => sendMessage('🎙️ Voice Note: I just unpacked 50 pairs of Nike Air Jordans, sizes 41–45, selling for ₦35,000 at my store in Wuse Market.')}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700/60 transition-all font-sans"
          >
            🎙️ AI Voice Inventory Sync
          </button>
          <button
            onClick={() => sendMessage('I want a smart watch in Wuse Market for 30k')}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700/60 transition-all font-sans"
          >
            🔍 Buyer Search (Logs in Firestore)
          </button>
          <button
            onClick={() => sendMessage('🎙️ Voice Note: Restocked 20 Smart Watch T800, selling for ₦28,000 in Wuse Market')}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700/60 transition-all font-sans"
          >
            ⚡ Trigger Restock Lead Radar
          </button>
        </div>

        {/* Input Bar */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            placeholder="Type a command (e.g., /start, /ai question) or message..."
            className="flex-1 bg-slate-950 border border-slate-800 focus:border-sky-500 text-slate-100 text-sm rounded-xl px-4 py-2.5 outline-none font-mono"
          />
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white p-2.5 rounded-xl transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Execution Logs & Server Console */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col h-[650px]">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
          <h4 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            Handler Debug Logs
          </h4>
          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-800 px-2 py-0.5 rounded">
            Live Console
          </span>
        </div>

        <div className="flex-1 bg-slate-950 rounded-xl p-3 font-mono text-xs text-slate-300 overflow-y-auto space-y-2 border border-slate-800/80">
          {logs.map((log, i) => (
            <div
              key={i}
              className={`leading-relaxed ${
                log.includes('[Error]')
                  ? 'text-rose-400'
                  : log.includes('[Bot Reply]')
                  ? 'text-emerald-400'
                  : 'text-slate-400'
              }`}
            >
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
