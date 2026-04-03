import { StorageProvider, StorageType } from './types';
import { LocalStorageProvider } from './localProvider';
import { S3StorageProvider } from './s3Provider';
import { OSSStorageProvider } from './ossProvider';
import { COSStorageProvider } from './cosProvider';

export function createStorageProviderForType(type: StorageType): StorageProvider {
  switch (type) {
    case 'local':
      return new LocalStorageProvider();
    case 's3':
      return new S3StorageProvider();
    case 'oss':
      return new OSSStorageProvider();
    case 'cos':
      return new COSStorageProvider();
    default:
      throw new Error(`Unsupported STORAGE_TYPE: ${type}`);
  }
}

export function createStorageProvider(): StorageProvider {
  const type = (process.env.STORAGE_TYPE || 'local') as StorageType;
  return createStorageProviderForType(type);
}

let instance: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (!instance) {
    instance = createStorageProvider();
  }
  return instance;
}
