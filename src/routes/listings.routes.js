const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

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

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const status = req.query.status ? String(req.query.status) : undefined;
    const breed = req.query.breed ? String(req.query.breed) : undefined;
    const city = req.query.city ? String(req.query.city) : undefined;
    const sort = req.query.sort ? String(req.query.sort) : "-createdAt";

    const where = {
      ...(status ? { status } : { status: { in: ["PUBLISHED", "RESERVED", "SOLD"] } }),
      ...(breed ? { breed } : {}),
      ...(city ? { city } : {}),
    };

    const orderBy = sort === "-priceKzt" ? [{ priceKzt: "desc" }, { id: "desc" }] : [{ createdAt: "desc" }, { id: "desc" }];

    const data = await prisma.listing.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = data.length > limit;
    const slice = hasNext ? data.slice(0, limit) : data;
    const nextCursor = hasNext ? slice[slice.length - 1].id : null;
    return res.status(200).json({ data: slice, meta: { hasNext, nextCursor } });
  } catch (error) {
    return next(error);
  }
});

router.post("/", requireAuth, requireRoles("SELLER"), async (req, res, next) => {
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
    return res.status(200).json(listing);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.patch("/:listingId", requireAuth, requireRoles("SELLER"), async (req, res, next) => {
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

router.delete("/:listingId", requireAuth, requireRoles("SELLER"), async (req, res, next) => {
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

router.post("/:listingId/submit-review", requireAuth, requireRoles("SELLER"), async (req, res, next) => {
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

module.exports = router;
