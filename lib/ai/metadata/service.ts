import { RuleBasedMetadataExtractor } from './extractor';
import { ExtractedMetadata } from './types';

const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 30_000);

export class MetadataExtractionService {
  static async extractMetadataAsync(text: string): Promise<ExtractedMetadata> {
    const llmEnabled = process.env.LLM_ENABLED === 'true';
    const provider = (process.env.AI_CLASSIFICATION_PROVIDER || 'fallback').toLowerCase();

    if (llmEnabled && provider === 'openai' && process.env.OPENAI_API_KEY) {
      try {
        const aiMeta = await this.callOpenAIMetadata(text);
        if (aiMeta) return aiMeta;
      } catch (err: any) {
        console.warn(`AI Metadata extraction failed: ${err.message}. Falling back to Rule-Based Extractor.`);
      }
    }

    return RuleBasedMetadataExtractor.extract(text);
  }

  static extractMetadata(text: string): ExtractedMetadata {
    return RuleBasedMetadataExtractor.extract(text);
  }

  private static async callOpenAIMetadata(text: string): Promise<ExtractedMetadata | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const prompt = `Extract legal metadata from the document text below.
Return a valid JSON object with the following keys ONLY:
- "caseNumber": string or null
- "documentDate": string or null
- "policeStation": string or null
- "officers": array of strings
- "persons": array of strings
- "locations": array of strings
- "organizations": array of strings
- "summary": string summary (1-3 sentences)

Do NOT invent information not present in the document.

Document Text:
"${text.substring(0, 2000)}"`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) return null;

    const parsed = JSON.parse(rawContent.replace(/```json|```/g, '').trim());
    return {
      caseNumber: parsed.caseNumber || null,
      documentDate: parsed.documentDate || null,
      policeStation: parsed.policeStation || null,
      officers: Array.isArray(parsed.officers) ? parsed.officers : [],
      persons: Array.isArray(parsed.persons) ? parsed.persons : [],
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
      organizations: Array.isArray(parsed.organizations) ? parsed.organizations : [],
      importantEntities: [
        ...new Set([
          ...(Array.isArray(parsed.persons) ? parsed.persons : []),
          ...(Array.isArray(parsed.locations) ? parsed.locations : []),
          ...(Array.isArray(parsed.organizations) ? parsed.organizations : []),
        ]),
      ],
      summary: parsed.summary || text.substring(0, 250),
    };
  }
}
