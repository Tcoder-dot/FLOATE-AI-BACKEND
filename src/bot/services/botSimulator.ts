import { getBotInstance } from '../bot.js';

export interface SimulatedReply {
  chatId: number;
  text: string;
  parseMode?: string;
  replyMarkup?: any;
}

let isTransformerAttached = false;
const globalRepliesMap = new Map<number, SimulatedReply[]>();

export async function processSimulatedMessage(
  userText: string,
  userId: number = 99912345,
  firstName: string = 'Tester'
): Promise<{ replies: SimulatedReply[]; logs: string[] }> {
  const bot = getBotInstance();
  const logs: string[] = [];

  if (!bot.botInfo) {
    bot.botInfo = {
      id: 123456789,
      is_bot: true,
      first_name: 'Floate AI Bot',
      username: 'floate_ai_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as any;
  }

  if (!isTransformerAttached) {
    isTransformerAttached = true;
    bot.api.config.use(async (prev: any, method: string, payload: any, signal: any) => {
      if (method === 'sendMessage') {
        const replyItem = {
          chatId: Number(payload.chat_id),
          text: String(payload.text),
          parseMode: payload.parse_mode,
          replyMarkup: payload.reply_markup,
        };
        const existing = globalRepliesMap.get(Number(payload.chat_id)) || [];
        existing.push(replyItem);
        globalRepliesMap.set(Number(payload.chat_id), existing);

        return {
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 10000),
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(payload.chat_id), type: 'private', first_name: firstName },
            text: String(payload.text),
          },
        } as any;
      }

      if (method === 'sendChatAction' || method === 'answerCallbackQuery') {
        return { ok: true, result: true } as any;
      }

      try {
        return await prev(method, payload, signal);
      } catch {
        return { ok: true, result: true } as any;
      }
    });
  }

  // Clear previous replies for this user ID
  globalRepliesMap.set(userId, []);

  try {
    const isCallback = userText.startsWith('cmd_') || userText.startsWith('role_') || userText.startsWith('toggle_') || userText.startsWith('reg_') || userText.startsWith('btn_') || userText.startsWith('edit_') || userText.startsWith('inv_');
    const isVoice = !isCallback && (userText.toLowerCase().includes('voice note') || userText.startsWith('🎙️'));

    // Construct standard Telegram Update structure
    let update: any;

    if (isCallback) {
      update = {
        update_id: Math.floor(Math.random() * 100000),
        callback_query: {
          id: String(Math.floor(Math.random() * 100000)),
          from: {
            id: userId,
            is_bot: false,
            first_name: firstName,
            username: 'test_user',
          },
          message: {
            message_id: Math.floor(Math.random() * 10000),
            chat: { id: userId, first_name: firstName, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: 'Menu',
          },
          data: userText,
        },
      };
    } else if (isVoice) {
      update = {
        update_id: Math.floor(Math.random() * 100000),
        message: {
          message_id: Math.floor(Math.random() * 10000),
          from: {
            id: userId,
            is_bot: false,
            first_name: firstName,
            username: 'test_user',
          },
          chat: {
            id: userId,
            first_name: firstName,
            type: 'private',
          },
          date: Math.floor(Date.now() / 1000),
          voice: {
            file_id: 'simulated_voice_file_id',
            duration: 5,
          },
          caption: userText,
        },
      };
    } else {
      update = {
        update_id: Math.floor(Math.random() * 100000),
        message: {
          message_id: Math.floor(Math.random() * 10000),
          from: {
            id: userId,
            is_bot: false,
            first_name: firstName,
            username: 'test_user',
          },
          chat: {
            id: userId,
            first_name: firstName,
            type: 'private',
          },
          date: Math.floor(Date.now() / 1000),
          text: userText,
        },
      };
    }

    logs.push(`[Incoming Update] ${userText}`);
    await bot.handleUpdate(update);
  } catch (err: any) {
    logs.push(`[Error] ${err?.message || err}`);
  }

  const capturedReplies = globalRepliesMap.get(userId) || [];
  return { replies: capturedReplies, logs };
}
