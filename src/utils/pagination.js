const { z } = require("zod");

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

function parsePagination(query) {
  return paginationSchema.parse(query);
}

function buildPagedResponse(rows, limit) {
  const hasNext = rows.length > limit;
  const data = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext ? data[data.length - 1].id : null;
  return { data, meta: { hasNext, nextCursor } };
}

module.exports = { parsePagination, buildPagedResponse };
