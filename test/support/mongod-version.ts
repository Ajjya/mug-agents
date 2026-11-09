/**
 * The mongod used by integration tests, pinned so results do not change when
 * mongodb-memory-server bumps its default. Keep the MAJOR in line with the Atlas cluster tier you
 * deploy on (8.0 here). Also set in package.json `config.mongodbMemoryServer.version` so the
 * postinstall hook pre-downloads exactly this binary; a unit test keeps the two equal.
 */
export const MONGOD_VERSION = '8.0.4';
