import { prisma } from '@/lib/db/prisma';
import { OCRService } from '@/lib/ocr/service';
import { ProcessingStatus } from '@prisma/client';
import { indexDocumentEmbeddings } from '@/lib/embeddings/indexer';
import { loadDocumentPlaintext } from '@/lib/documents/document-bytes';

const PROCESSING_STEP_TIMEOUT_MS = Number(process.env.PROCESSING_STEP_TIMEOUT_MS || 45_000);

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${PROCESSING_STEP_TIMEOUT_MS}ms`));
    }, PROCESSING_STEP_TIMEOUT_MS);

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

export class ProcessingService {
  static async processDocumentJob(documentId: string, versionId?: string): Promise<{ success: boolean; pagesCount: number; error?: string }> {
    // 1. Fetch target Document & Version
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
        },
        processingJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!document || document.versions.length === 0) {
      throw new Error(`Processing error: Document or version record not found for ID ${documentId}`);
    }

    const version = versionId
      ? document.versions.find((v) => v.id === versionId) || document.versions[0]
      : document.versions[0];

    const activeJob = document.processingJobs[0];

    // 2. Update ProcessingJob status -> PROCESSING, step -> DECRYPTING
    if (activeJob) {
      await prisma.processingJob.update({
        where: { id: activeJob.id },
        data: {
          status: ProcessingStatus.PROCESSING,
          currentStep: 'DECRYPTING',
          startedAt: new Date(),
        },
      });
    }

    try {
      // 3. Retrieve stored bytes and decrypt through the shared document storage abstraction.
      const resolvedBytes = await loadDocumentPlaintext({
        storageKey: version.storageKey,
        encryptionAlgorithm: version.encryptionAlgorithm,
        iv: version.iv,
        authTag: version.authTag,
      });
      const plaintextBuffer = resolvedBytes.plaintext;

      // 4. Update step -> OCR_PROCESSING
      if (activeJob) {
        await prisma.processingJob.update({
          where: { id: activeJob.id },
          data: { currentStep: 'OCR_PROCESSING' },
        });
      }

      // 5. Execute OCR / Text Extraction
      const ocrResult = await withTimeout(
        OCRService.processDocument(plaintextBuffer, document.mimeType),
        'OCR processing'
      );

      if (!ocrResult.success) {
        throw new Error(ocrResult.error || 'OCR text extraction failed');
      }

      // 6. Store OCR pages
      await prisma.$transaction(async (tx) => {
        await tx.ocrPage.deleteMany({
          where: { versionId: version.id },
        });

        for (const p of ocrResult.pages) {
          await tx.ocrPage.create({
            data: {
              documentId: document.id,
              versionId: version.id,
              pageNumber: p.pageNumber,
              text: p.text,
              confidence: p.confidence,
              method: p.method,
            },
          });
        }
      });

      // 6b. Build semantic chunk embeddings for pgvector search.
      await withTimeout(
        indexDocumentEmbeddings(
          document.id,
          version.id,
          ocrResult.pages.map((page) => ({
            pageNumber: page.pageNumber,
            text: page.text,
          }))
        ),
        'Embedding indexing'
      );

      // Combine text for AI Classification & Metadata Extraction
      const combinedText = ocrResult.pages.map((p) => p.text).join('\n\n');

      // 7. Step -> CLASSIFICATION
      if (activeJob) {
        await prisma.processingJob.update({
          where: { id: activeJob.id },
          data: { currentStep: 'CLASSIFICATION' },
        });
      }
      const { ClassificationService } = await import('@/lib/ai/classification/service');
      const classificationRes = await ClassificationService.classifyDocument(combinedText);

      // 8. Step -> METADATA_EXTRACTION
      if (activeJob) {
        await prisma.processingJob.update({
          where: { id: activeJob.id },
          data: { currentStep: 'METADATA_EXTRACTION' },
        });
      }
      const { MetadataExtractionService } = await import('@/lib/ai/metadata/service');
      const extractedMeta = await MetadataExtractionService.extractMetadataAsync(combinedText);

      // 9. Update Document, DocumentMetadata, and ProcessingJob
      await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: document.id },
          data: {
            documentType: classificationRes.classification,
            status: ProcessingStatus.COMPLETED,
          },
        });

        await tx.documentMetadata.upsert({
          where: { documentId: document.id },
          create: {
            documentId: document.id,
            caseNumber: extractedMeta.caseNumber,
            documentDate: extractedMeta.documentDate,
            policeStation: extractedMeta.policeStation,
            officer: extractedMeta.officers[0] || null,
            persons: extractedMeta.persons,
            locations: extractedMeta.locations,
            organizations: extractedMeta.organizations,
            summary: extractedMeta.summary,
            rawMetadata: JSON.parse(
              JSON.stringify({
                classification: classificationRes,
                metadata: extractedMeta,
              })
            ),
          },
          update: {
            caseNumber: extractedMeta.caseNumber,
            documentDate: extractedMeta.documentDate,
            policeStation: extractedMeta.policeStation,
            officer: extractedMeta.officers[0] || null,
            persons: extractedMeta.persons,
            locations: extractedMeta.locations,
            organizations: extractedMeta.organizations,
            summary: extractedMeta.summary,
            rawMetadata: JSON.parse(
              JSON.stringify({
                classification: classificationRes,
                metadata: extractedMeta,
              })
            ),
          },
        });

        if (activeJob) {
          await tx.processingJob.update({
            where: { id: activeJob.id },
            data: {
              status: ProcessingStatus.COMPLETED,
              currentStep: 'COMPLETED',
              completedAt: new Date(),
              errorMessage: null,
            },
          });
        }
      });

      return { success: true, pagesCount: ocrResult.pages.length };
    } catch (error: any) {
      console.error('ProcessingService error:', error.message);

      if (activeJob) {
        await prisma.processingJob.update({
          where: { id: activeJob.id },
          data: {
            status: ProcessingStatus.FAILED,
            currentStep: 'FAILED',
            errorMessage: error.message,
          },
        });
      }

      await prisma.document.update({
        where: { id: document.id },
        data: { status: ProcessingStatus.FAILED },
      });

      return { success: false, pagesCount: 0, error: error.message };
    }
  }
}
