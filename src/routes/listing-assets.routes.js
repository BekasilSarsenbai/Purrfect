const express = require("express");
const { z } = require("zod");
const { prisma } = require("../config/prisma");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { ApiError } = require("../utils/errors");

const router = express.Router();

const addMediaSchema = z.object({
  mediaType: z.enum(["PHOTO", "VIDEO"]),
  storageUrl: z.string().url(),
  checksumSha256: z.string().min(16).max(128),
});

const addDocumentSchema = z.object({
  docType: z.enum(["PEDIGREE", "VACCINATION", "HEALTH_PASSPORT", "OTHER"]),
  storageUrl: z.string().url(),
  checksumSha256: z.string().min(16).max(128),
});

const verifyDocumentSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

async function getOwnedListingOrThrow(listingId, userId) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
  if (listing.sellerId !== userId) throw new ApiError(403, "FORBIDDEN", "Listing does not belong to seller");
  return listing;
}

router.post("/:listingId/media", requireAuth, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = addMediaSchema.parse(req.body);
    await getOwnedListingOrThrow(listingId, req.user.id);

    const media = await prisma.listingMedia.create({
      data: {
        listingId,
        mediaType: body.mediaType,
        storageUrl: body.storageUrl,
        checksumSha256: body.checksumSha256,
      },
    });
    return res.status(201).json(media);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:listingId/media", async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    const media = await prisma.listingMedia.findMany({
      where: { listingId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return res.status(200).json(media);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:listingId/documents", requireAuth, requireRoles("SELLER"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const body = addDocumentSchema.parse(req.body);
    await getOwnedListingOrThrow(listingId, req.user.id);

    const document = await prisma.listingDocument.create({
      data: {
        listingId,
        docType: body.docType,
        storageUrl: body.storageUrl,
        checksumSha256: body.checksumSha256,
      },
    });
    return res.status(201).json(document);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.get("/:listingId/documents", requireAuth, async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    const isOwner = listing.sellerId === req.user.id;
    const isStaff = ["MODERATOR", "ADMIN"].includes(req.user.role);
    if (!isOwner && !isStaff) throw new ApiError(403, "FORBIDDEN", "No access to documents");

    const docs = await prisma.listingDocument.findMany({
      where: { listingId },
      include: { verifications: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return res.status(200).json(docs);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

router.post("/:listingId/documents/:documentId/verify", requireAuth, requireRoles("MODERATOR", "ADMIN"), async (req, res, next) => {
  try {
    const listingId = z.string().uuid().parse(req.params.listingId);
    const documentId = z.string().uuid().parse(req.params.documentId);
    const body = verifyDocumentSchema.parse(req.body);

    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new ApiError(404, "NOT_FOUND", "Listing not found");
    const document = await prisma.listingDocument.findUnique({ where: { id: documentId } });
    if (!document || document.listingId !== listingId) throw new ApiError(404, "NOT_FOUND", "Document not found");

    const verification = await prisma.documentVerification.create({
      data: {
        documentId,
        moderatorId: req.user.id,
        decision: body.decision,
        note: body.note || null,
      },
    });
    return res.status(201).json(verification);
  } catch (error) {
    if (error instanceof z.ZodError) return next(new ApiError(422, "VALIDATION_ERROR", "Validation failed", error.flatten()));
    return next(error);
  }
});

module.exports = router;
