import { AgentGraphLLMResponse, AgentGraphModel, StreamChunkCallback } from '../model/AgentGraphModel';
import { BaseMessage } from '@langchain/core/messages';
import { CreateAgentOptions } from '../agent/createAgent';

export class LLMModel extends AgentGraphModel {
  private chatId: string;
  private options: CreateAgentOptions;

  constructor(options: CreateAgentOptions) {
    super();
    this.chatId = '';
    this.options = options;
  }

  resetChat() {
    this.chatId = '';
  }

  async callApi(prompt: string): Promise<AgentGraphLLMResponse> {
    const response = await fetch(this.options.apiUrl, {
      method: 'POST',
      body: JSON.stringify({
        query: prompt,
        chatId: this.chatId,
        stream: false,
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`LLM API 响应异常: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();

    this.chatId = data.chat_id || data.chatId;

    return {
      text: data.text || '',
      reasoning: data.reason || data.thought || '', // 适配后端可能的思考字段名
      token: data.token, // ✅ 确保这里取到了 API 返回的 token
      duration: data.duration, // ✅ 确保这里取到了 API 返回的 duration
    };
  }

  /**
   * 流式调用 API：发送 stream: true，自动适配多种响应格式（SSE / NDJSON / 普通 JSON）。
   */
  /**
   * 流式调用 API：发送 stream: true
   * 适配 SSE 格式，解析内容增量、思考过程以及最终的 Token 统计
   */
  async callApiStream(prompt: string, lastMsg: BaseMessage, onChunk: StreamChunkCallback): Promise<AgentGraphLLMResponse> {
    const files = (lastMsg?.additional_kwargs as any)?.files || [];

    const response = await fetch(this.options.apiUrl, {
      method: 'POST',
      body: JSON.stringify({
        query: prompt,
        chatId: this.chatId,
        stream: true,
        files
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`LLM API 响应异常: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // ✅ 情况1: 兜底处理非流式响应
    if (contentType.includes('application/json')) {
      const data: any = await response.json();
      this.chatId = data.chat_id || data.chatId;
      const text = data.text || data.content || '';
      if (text) onChunk(text);
      return {
        text,
        reasoning: data.reason || data.thought || data.reasoning_content || '',
        token: data.total_tokens || data.token || 0,
        duration: data.duration || 0,
      };
    }

    // ✅ 情况2: 流式响应处理
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('响应体不支持流式读取');
    }

    const decoder = new TextDecoder();
    let fullText = '';
    let reasoning = '';
    let token = 0;
    let duration = 0;
    let buffer = '';
    let currentEvent = ''; // 记录当前的 SSE 事件类型

    /**
     * 内部解析函数：处理每一行 SSE 数据
     */
    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // 1. 识别事件类型 (如 event: answer)
      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.slice(6).trim();
        return;
      }

      // 2. 提取 Data 字符串
      let dataStr = trimmed;
      if (trimmed.startsWith('data:')) {
        dataStr = trimmed.slice(5).trim();
      }

      // 跳过结束标志
      if (dataStr === '[DONE]') return;

      try {
        const data = JSON.parse(dataStr);

        // A. 提取对话文本 (仅在 answer 事件中)
        if (currentEvent === 'answer' || data.event === 'answer') {
          const chunkText = data.delta?.content || data.text || '';
          if (chunkText) {
            onChunk(chunkText);
            fullText += chunkText;
          }
          // 提取流式思考内容 (如果有)
          const rChunk = data.delta?.reasoning_content || '';
          if (rChunk) reasoning += rChunk;
        }

        // B. 提取统计信息 (在 done 或 flowNodeStatus 事件中)
        // 根据你的日志，统计数据可能在 data.data 下或根部
        const nestedData = data.data || data;

        // 关键：优先匹配 total_tokens
        const foundToken = nestedData.total_tokens || nestedData.totalTokens || nestedData.token || 0;
        const foundDuration = nestedData.duration || 0;

        if (foundToken > 0) token = foundToken;
        if (foundDuration > 0) duration = foundDuration;

        // C. 更新会话 ID
        if (data.chat_id || data.chatId) {
          this.chatId = data.chat_id || data.chatId;
        }

        // D. 提取非流式的完整思考内容
        const fullReasoning = nestedData.reasoning_content || nestedData.reason || nestedData.thought;
        if (fullReasoning && currentEvent !== 'answer') {
          reasoning = fullReasoning;
        }

      } catch (e) {
        // 非 JSON 格式行，且当前处于回答状态时，作为纯文本 fallback
        if (currentEvent === 'answer') {
          onChunk(trimmed);
          fullText += trimmed;
        }
      }
    };

    // 主循环：读取流
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 留下不完整的一行在下个循环处理

      for (const line of lines) {
        processLine(line);
      }
    }

    // 处理流结束后的残留 buffer
    if (buffer.trim()) {
      processLine(buffer);
    }

    return {
      text: fullText,
      reasoning,
      token,
      duration
    };
  }
}