export interface OpenRouterModel {
	id: string;
	name: string;
	context_length: number;
	pricing?: {
		prompt: string;
		completion: string;
	};
}

export interface SessionUpdateStreamChunk {
	type: 'text_delta' | 'thinking_delta' | 'tool_call' | 'stop';
	text?: string;
	thinking?: string;
	toolCall?: { id: string; name: string; args: unknown };
}

export class OpenRouterEngineAdapter {
	private apiKey?: string;

	constructor(apiKey?: string) {
		this.apiKey = apiKey || process.env.OPENROUTER_API_KEY;
	}

	async discoverModels(): Promise<OpenRouterModel[]> {
		try {
			const res = await fetch('https://openrouter.ai/api/v1/models');
			if (!res.ok) return [];
			const json = await res.json();
			return (json.data || []).map((m: any) => ({
				id: m.id,
				name: m.name || m.id,
				context_length: m.context_length || 128000,
				pricing: m.pricing,
			}));
		} catch {
			return [
				{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (OpenRouter)', context_length: 200000 },
				{ id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (OpenRouter)', context_length: 64000 },
				{ id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash (OpenRouter)', context_length: 1000000 },
			];
		}
	}

	normalizeChunk(rawChunk: Record<string, any>): SessionUpdateStreamChunk[] {
		const choices = rawChunk.choices || [];
		const updates: SessionUpdateStreamChunk[] = [];

		for (const choice of choices) {
			const delta = choice.delta || {};

			if (delta.reasoning || delta.thinking) {
				updates.push({
					type: 'thinking_delta',
					thinking: delta.reasoning || delta.thinking,
				});
			}

			if (delta.content) {
				updates.push({
					type: 'text_delta',
					text: delta.content,
				});
			}

			if (delta.tool_calls && delta.tool_calls.length > 0) {
				for (const tc of delta.tool_calls) {
					updates.push({
						type: 'tool_call',
						toolCall: {
							id: tc.id || `tc-${Date.now()}`,
							name: tc.function?.name || 'unknown',
							args: tc.function?.arguments,
						},
					});
				}
			}
		}

		return updates;
	}
}
