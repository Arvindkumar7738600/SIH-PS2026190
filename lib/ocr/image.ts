import { createWorker } from 'tesseract.js';
import { OcrProcessingResult } from './types';
import path from 'path';
import os from 'os';

const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 40_000);
const TESSERACT_VERSION = '5.1.1';
const TESSERACT_CORE_CDN = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`;
const TESSERACT_LANG_CDN = 'https://tessdata.projectnaptha.com/4.0.0';

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${OCR_TIMEOUT_MS}ms`));
    }, OCR_TIMEOUT_MS);

    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function extractTextFromImage(buffer: Buffer): Promise<OcrProcessingResult> {
  let worker: any = null;
  try {
    const cachePath = path.join(os.tmpdir(), 'tesseract-cache');
    const runningOnVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL);

    // Node still needs a local worker-thread entrypoint, but its core and
    // language assets can be downloaded from CDN instead of /var/task.
    worker = await withTimeout(createWorker('eng', 1, {
      cachePath,
      workerPath: process.env.TESSERACT_WORKER_PATH || path.join(
        process.cwd(),
        'node_modules/tesseract.js/src/worker-script/node/index.js'
      ),
      ...(runningOnVercel ? {
        corePath: process.env.TESSERACT_CORE_PATH || TESSERACT_CORE_CDN,
        langPath: process.env.TESSERACT_LANG_PATH || TESSERACT_LANG_CDN,
      } : {}),
      logger: () => { },
    }), 'OCR worker initialization');

    // Image recognize karein (Ise ab pura time milega)
    const recognition = await withTimeout<{ data: { text?: string; confidence?: number } }>(
      worker.recognize(buffer),
      'OCR image recognition'
    );
    const { data } = recognition;
    const recognizedText = data.text ? data.text.trim() : '';

    return {
      success: true,
      pages: [
        {
          pageNumber: 1,
          text: recognizedText.length > 0 ? recognizedText : 'No text found in image.',
          confidence: typeof data.confidence === 'number' ? Number(data.confidence.toFixed(2)) : 90,
          method: 'OCR',
        },
      ],
      totalPages: 1,
      method: 'OCR',
    };
  } catch (err: any) {
    console.error('OCR Extraction Error:', err);
    return {
      success: false,
      pages: [
        {
          pageNumber: 1,
          text: `OCR Error: ${err.message || 'Failed to extract text'}`,
          confidence: 0,
          method: 'OCR',
        },
      ],
      totalPages: 1,
      method: 'OCR',
    };
  } finally {
    if (worker) {
      await worker.terminate().catch((terminationError: unknown) => {
        console.error('OCR worker termination error:', terminationError);
      });
    }
  }
}
