import OpenAI from 'openai';
import type { Message, StoredSettings, ToolCall } from './storage';

export type LLMTool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
};

export interface LLMResponse {
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
}

// Convert internal Message format to OpenAI API format
function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
        if (msg.role === 'user') {
            result.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant') {
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                result.push({
                    role: 'assistant',
                    content: msg.content || null,
                    tool_calls: msg.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                    })),
                });
            } else {
                result.push({ role: 'assistant', content: msg.content });
            }
        } else if (msg.role === 'tool') {
            result.push({
                role: 'tool',
                tool_call_id: msg.toolCallId!,
                content: msg.content,
            });
        }
    }

    return result;
}

export async function callLLM(
    settings: StoredSettings,
    systemPrompt: string,
    messages: Message[],
    tools: LLMTool[],
): Promise<LLMResponse> {
    if (!settings.apiKey) {
        throw new Error('No API key configured. Please set your API key in EDITH settings.');
    }

    const client = new OpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.apiBaseUrl,
        dangerouslyAllowBrowser: true, // Required for browser extension context
    });

    const openaiMessages = toOpenAIMessages(messages);
    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map((t) => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
    }));

    const response = await client.chat.completions.create({
        model: settings.model,
        messages: [{ role: 'system', content: systemPrompt }, ...openaiMessages],
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
        max_completion_tokens: 4096,
    });

    const choice = response.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
        content: choice.message.content || '',
        toolCalls,
        finishReason: choice.finish_reason || 'stop',
    };
}
