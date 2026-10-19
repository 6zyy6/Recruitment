import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// A versioned document store keeps this single-company demo small. It is not a production ATS schema.
export const recruitmentState = sqliteTable('recruitment_state', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
});
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
