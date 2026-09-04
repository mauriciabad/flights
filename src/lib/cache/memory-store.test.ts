import { MemoryCacheStore } from './memory-store';
import { defineCacheStoreContractTests } from './store-contract';

defineCacheStoreContractTests(
	'MemoryCacheStore',
	(options) => new MemoryCacheStore({ maxSizeBytes: options?.maxSizeBytes })
);
