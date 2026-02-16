export interface StorageAdapter {
  upload(key: string, buffer: Buffer, mimeType: string): Promise<void>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  copy(sourceKey: string, destKey: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number): Promise<string>;
  getPublicUrl(key: string): string;
}

export interface StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}
