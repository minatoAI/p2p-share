import type { FileMeta, SinkPort, WriteSession } from '../../core/ports';

export interface StoredFile {
  meta: FileMeta;
  bytes: Uint8Array;
  committed: boolean;
  aborted: boolean;
}

/**
 * Node 测试用的落盘实现，同时用来验证能力声明的两条分支。
 * 浏览器实现见 adapters/browser/sink.ts。
 */
export class MemorySink implements SinkPort {
  readonly files: StoredFile[] = [];
  readonly texts: string[] = [];
  async begin(meta: FileMeta): Promise<WriteSession> {
    const parts: Uint8Array[] = [];
    const record: StoredFile = { meta, bytes: new Uint8Array(0), committed: false, aborted: false };
    this.files.push(record);
    return {
      write: async (chunk: Uint8Array) => {
        parts.push(chunk.slice());
      },
      commit: async () => {
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) {
          out.set(p, offset);
          offset += p.byteLength;
        }
        record.bytes = out;
        record.committed = true;
        return {
          name: record.meta.name,
          mime: record.meta.mime,
          size: out.byteLength,
          open: async () => new Blob([out as BlobPart], { type: record.meta.mime }),
        };
      },
      abort: async () => {
        record.aborted = true;
        parts.length = 0;
      },
    };
  }

  async receiveText(text: string): Promise<void> {
    this.texts.push(text);
  }
}
