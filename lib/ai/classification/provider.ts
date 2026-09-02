import { DocumentType } from '@prisma/client';
import { ClassificationResult } from './types';
import { RuleBasedClassifier } from './fallback';
import { z } from 'zod';

const DocumentTypeSchema = z.nativeEnum(DocumentType);
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 30_000);

export class AIClassificationProvider {
  static async classify(text: string): Promise<ClassificationResult> {
    const provider = (process.env.AI_CLASSIFICATION_PROVIDER || 'fallback').toLowerCase();
    const llmEnabled = process.env.LLM_ENABLED === 'true';

    if (!llmEnabled || provider === 'fallback') {
      return RuleBasedClassifier.classifyText(text);
    }

    try {
      if (provider === 'openai' && process.env.OPENAI_API_KEY) {
        const result = await this.callOpenAI(text);
        if (result && DocumentTypeSchema.safeParse(result.classification).success) {
          return result;
        }
      } else if (provider === 'huggingface' && process.env.HUGGINGFACE_API_KEY) {
        const result = await this.callHuggingFace(text);
        if (result && DocumentTypeSchema.safeParse(result.classification).success) {
          return result;
        }
      }
    } catch (error: any) {
      console.warn(`AI Provider "${provider}" failed: ${error.message}. Falling back to Rule-Based Classifier.`);
    }

    // Fallback to deterministic rule-based classifier
    return RuleBasedClassifier.classifyText(text);
  }

  private static async callOpenAI(text: string): Promise<ClassificationResult | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const prompt = `Classify the following legal/police document text into exactly ONE of these categories:
FIR, POLICE_REPORT, INVESTIGATION_REPORT, WITNESS_STATEMENT, CHARGE_SHEET, COURT_FILING, EVIDENCE_REPORT, FORENSIC_REPORT, LEGAL_DOCUMENT, JUDGMENT, OTHER.

Return valid JSON with keys: "classification", "confidence" (0.0 to 1.0), and "reason".

Document Content snippet:
"${text.substring(0, 1500)}"`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) return null;

    const parsed = JSON.parse(rawContent.replace(/```json|```/g, '').trim());
    return {
      classification: parsed.classification as DocumentType,
      confidence: Number(parsed.confidence) || 0.85,
      method: 'AI_OPENAI',
      reason: parsed.reason || 'AI OpenAI GPT Classification',
    };
  }

  private static async callHuggingFace(text: string): Promise<ClassificationResult | null> {
    const apiKey = process.env.HUGGINGFACE_API_KEY;
    if (!apiKey) return null;

    const candidateLabels = [
      'FIR',
      'POLICE_REPORT',
      'INVESTIGATION_REPORT',
      'WITNESS_STATEMENT',
      'CHARGE_SHEET',
      'COURT_FILING',
      'EVIDENCE_REPORT',
      'FORENSIC_REPORT',
      'LEGAL_DOCUMENT',
      'JUDGMENT',
      'OTHER',
    ];

    const response = await fetch('https://api-inference.huggingface.co/models/facebook/bart-large-mnli', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        inputs: text.substring(0, 1000),
        parameters: { candidate_labels: candidateLabels },
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const topLabel = data.labels?.[0];
    const topScore = data.scores?.[0];

    if (topLabel && candidateLabels.includes(topLabel)) {
      return {
        classification: topLabel as DocumentType,
        confidence: Number(topScore) || 0.80,
        method: 'AI_HUGGINGFACE',
        reason: `HuggingFace BART-MNLI zero-shot classification (confidence: ${((topScore || 0) * 100).toFixed(1)}%)`,
      };
    }

    return null;
  }
}
