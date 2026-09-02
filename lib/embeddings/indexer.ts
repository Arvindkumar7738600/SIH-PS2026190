import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db/prisma';
import {
  buildDocumentChunksFromPages,
  vectorToPgvectorLiteral,
  generateEmbedding,
  EmbeddingPageInput,
} from './semantic-search';

const EMBEDDING_DB_TIMEOUT_MS = Number(process.env.EMBEDDING_DB_TIMEOUT_MS || 30_000);

export async function indexDocumentEmbeddings(
  documentId: string,
  versionId: string,
  pages: EmbeddingPageInput[]
): Promise<number> {
  const chunks = buildDocumentChunksFromPages(pages);

  await prisma.$transaction(async (tx) => {
    await tx.documentChunk.deleteMany({
      where: { versionId },
    });

    if (chunks.length === 0) {
      return;
    }

    for (const chunk of chunks) {
      const embedding = generateEmbedding(chunk.content);
      const embeddingLiteral = vectorToPgvectorLiteral(embedding);

      await tx.$executeRaw`
        INSERT INTO "document_chunks" (
          "id",
          "document_id",
          "version_id",
          "page_number",
          "chunk_index",
          "content",
          "embedding"
        )
        VALUES (
          ${randomUUID()},
          ${documentId},
          ${versionId},
          ${chunk.pageNumber},
          ${chunk.chunkIndex},
          ${chunk.content},
          ${embeddingLiteral}::vector(384)
        )
      `;
    }
  }, { timeout: EMBEDDING_DB_TIMEOUT_MS });

  return chunks.length;
}
