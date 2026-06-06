'use strict';

const { MongoClient } = require('mongodb');
const logger = require('../logger');

/**
 * Thin wrapper around a single MongoClient connection.
 * Read-only by intent: this bot only consumes data written by the main app.
 */
class Mongo {
  /**
   * @param {object} opts { url, dbName }
   */
  constructor({ url, dbName } = {}) {
    this.url = url || null;
    this.dbName = dbName || null;
    this.client = null;
    this.db = null;
  }

  get enabled() {
    return !!this.url;
  }

  async connect() {
    if (!this.url) throw new Error('DATABASE_URL is not set');
    if (this.db) return this.db;
    this.client = new MongoClient(this.url, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 5,
    });
    await this.client.connect();
    // db name comes from the connection string unless explicitly overridden
    this.db = this.dbName ? this.client.db(this.dbName) : this.client.db();
    logger.info(`[mongo] connected (db=${this.db.databaseName})`);
    return this.db;
  }

  collection(name) {
    if (!this.db) throw new Error('[mongo] not connected; call connect() first');
    return this.db.collection(name);
  }

  async close() {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
      this.db = null;
      logger.info('[mongo] connection closed');
    }
  }
}

module.exports = { Mongo };
