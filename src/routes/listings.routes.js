const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles, requireVerifiedEmail } = require("../middleware/auth");
const { verifyAccessToken } = require("../services/token-service");
const { parsePagination, buildPagedResponse } = require("../utils/pagination");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const PUBLIC_LISTING_STATUSES = ["PUBLISHED", "RESERVED", "SOLD"];

const createListingSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  breed: z.string().min(2),
  gender: z.enum(["MALE", "FEMALE"]),
  birthDate: z.string().date(),
  vaccinationStatus: z.string().min(2),
  priceKzt: z.number().positive(),
  city: z.string().min(2),
  healthNotes: z.string().optional(),
});

const updateListingSchema = createListingSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: "At least one field is required",
});

const listingFilterSchema = z.object({
  status: z.enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "RESERVED", "SOLD", "REJECTED", "ARCHIVED"]).optional(),
  breed: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  priceMin: z.coerce.number().nonnegative().optional(),
  priceMax: z.coerce.number().positive().optional(),
  q: z.string().min(1).max(120).optional(),
  sort: z.enum(["-createdAt", "createdAt", "-priceKzt", "priceKzt"]).default("-createdAt"),
});

const reportSchema = z.object({
  reasonCode: z.enum(["FRAUD", "MISLEADING", "HEALTH_CONCERN", "INAPPROPRIATE", "OTHER"]),
  note: z.string().max(1000).optional(),
});

function buildOrderBy(sort) {
  const map = {
    "-createdAt": [{ createdAt: "desc" }, { id: "desc" }],
    createdAt: [{ createdAt: "asc" }, { id: "asc" }],
    "-priceKzt": [{ priceKzt: "desc" }, { id: "desc" }],
    priceKzt: [{ priceKzt: "asc" }, { id: "asc" }],
  };
  return map[sort] || map["-createdAt"];
}

async function tryGetUserFromBearer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  try {
    const payload = verifyAccessToken(authHeader.replace("Bearer ", ""));
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true },
    });
    if (!user || user.status !== "ACTIVE") return null;
    return user;
  } catch (_e) {
    return null;
  }
}

router.get("/", async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const filters = listingFilterSchema.parse(req.query);

    const priceFilter =
      filters.priceMin !== undefined || filters.priceMax !== undefined
        ? {
            priceKzt: {
              ...(filters.priceMin !== undefined ? { gte: filters.priceMin } : {}),
              ...(filters.priceMax !== undefined ? { lte: filters.priceMax } : {}),
            },
          }
        : {};

    const textFilter = filters.q
      ? {
          OR: [
            { title: { contains: filters.q, mode: "insensitive" } },
            { description: { contains: filters.q, mode: "insensitive" } },
            { breed: { contains: filters.q, mode: "insensitive" } },
          ],
        }
      : {};

    const where = {
      ...(filters.status ? { status: filters.status } : { status: { in: PUBLIC_LISTING_STATUSES } }),
      ...(filters.breed ? { breed: filters.breed } : {}),
      ...(filters.city ? { city: filters.city } : {}),
      ...priceFilter,
      ...textFilter,
    };

    const data = await prisma.listing.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    return res.status(200).json(buildPagedResponse(data, limit));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/search", async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const filters = listingFilterSchema.parse(req.query);

    const where = {
      status: filters.status || { in: PUBLIC_LISTING_STATUSES },
      ...(filters.breed ? { breed: filters.breed } : {}),
      ...(filters.city ? { city: filters.city } : {}),
      ...(filters.priceMin !== undefined || filters.priceMax !== undefined
        ? {
            priceKzt: {
              ...(filters.priceMin !== undefined ? { gte: filters.priceMin } : {}),
              ...(filters.priceMax !== undefined ? { lte: filters.priceMax } : {}),
            },
          }
        : {}),
      ...(filters.q
        ? {
            OR: [
              { title: { contains: filters.q, mode: "insensitive" } },
              { description: { contains: filters.q, mode: "insensitive" } },
              { breed: { contains: filters.q, mode: "insensitive" } },
              { city: { contains: filters.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const data = await prisma.listing.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    return res.status(200).json(buildPagedResponse(data, limit));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { limit, cursor } = parsePagination(req.query);
    const status = req.query.status
      ? z
          .enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "RESERVED", "SOLD", "REJECTED", "ARCHIVED"])
          .parse(req.query.status)
      : undefined;

    const data = await prisma.listing.findMany({
      where: { sellerId: req.user.id, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    return res.status(200).json(buildPagedResponse(data, limit));
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/", requireAuth, requireVerifiedEmail, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const body = createListingSchema.parse(req.body);
    const created = await prisma.listing.create({
      data: {
        ...body,
        sellerId: req.user.id,
        birthDate: new Date(body.birthDate),
      },
    });
    return res.status(201).json(created);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:listingId", async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");

    if (!PUBLIC_LISTING_STATUSES.includes(listing.status)) {
      const user = await tryGetUserFromBearer(req);
      const isOwner = user && user.id === listing.sellerId;
      const isStaff = user && ["MODERATOR", "ADMIN"].includes(user.role);
      if (!isOwner && !isStaff) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    }

    return res.status(200).json(listing);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.patch("/:listingId", requireAuth, requireVerifiedEmail, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = updateListingSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.sellerId !== req.user.id) throw new ApiError(403, "FORBIDDEN", "Listing does not belong to seller");
    if (!["DRAFT", "PENDING_REVIEW"].includes(listing.status)) throw new ApiError(409, "CONFLICT", "Listing cannot be updated in current status");

    const updated = await prisma.listing.update({
      where: { id: listingId },
      data: {
        ...body,
        ...(body.birthDate ? { birthDate: new Date(body.birthDate) } : {}),
      },
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.delete("/:listingId", requireAuth, requireVerifiedEmail, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.sellerId !== req.user.id) throw new ApiError(403, "FORBIDDEN", "Listing does not belong to seller");

    await prisma.listing.update({ where: { id: listingId }, data: { status: "ARCHIVED" } });
    return res.status(200).json({ status: "ARCHIVED" });
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:listingId/submit-review", requireAuth, requireVerifiedEmail, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.sellerId !== req.user.id) throw new ApiError(403, "FORBIDDEN", "Listing does not belong to seller");
    if (listing.status !== "DRAFT") throw new ApiError(409, "CONFLICT", "Only draft listings can be submitted");

    const updated = await prisma.listing.update({
      where: { id: listingId },
      data: { status: "PENDING_REVIEW" },
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:listingId/republish", requireAuth, requireVerifiedEmail, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.sellerId !== req.user.id) throw new ApiError(403, "FORBIDDEN", "Listing does not belong to seller");
    if (!["REJECTED", "ARCHIVED"].includes(listing.status)) {
      throw new ApiError(409, "CONFLICT", "Only rejected or archived listings can be republished");
    }

    const updated = await prisma.listing.update({
      where: { id: listingId },
      data: { status: "DRAFT" },
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:listingId/report", requireAuth, async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = reportSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    if (listing.sellerId === req.user.id) throw new ApiError(409, "CONFLICT", "Cannot report your own listing");

    const created = await prisma.moderationCase.create({
      data: {
        listingId,
        caseType: "USER_REPORT",
        status: "OPEN",
        decisionNote: `Reporter ${req.user.id} | Reason ${body.reasonCode}${body.note ? ` | ${body.note}` : ""}`,
      },
    });
    return res.status(201).json(created);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
