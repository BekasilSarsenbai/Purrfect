-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('BUYER', 'SELLER', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'RESERVED', 'SOLD', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'FUNDED_100', 'HANDOVER_CONFIRMED', 'INSPECTION_ACTIVE', 'DISPUTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED_REFUND_FULL', 'RESOLVED_REFUND_PARTIAL', 'RESOLVED_RELEASE_SELLER', 'REJECTED');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('ESCROW_HOLD', 'PAYOUT_MILESTONE_1', 'PAYOUT_MILESTONE_2', 'REFUND_FULL', 'REFUND_PARTIAL', 'PLATFORM_FEE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "VerificationDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "displayName" TEXT NOT NULL,
    "trustScore" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "breed" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3) NOT NULL,
    "vaccinationStatus" TEXT NOT NULL,
    "healthNotes" TEXT,
    "priceKzt" DECIMAL(12,2) NOT NULL,
    "city" TEXT NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingMedia" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingDocument" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVerification" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "decision" "VerificationDecision" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "totalAmountKzt" DECIMAL(12,2) NOT NULL,
    "platformFeeKzt" DECIMAL(12,2) NOT NULL,
    "payout1Kzt" DECIMAL(12,2) NOT NULL,
    "payout2Kzt" DECIMAL(12,2) NOT NULL,
    "fundedAt" TIMESTAMP(3),
    "handoverAt" TIMESTAMP(3),
    "inspectionDeadline" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowTransaction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "txType" "TxType" NOT NULL,
    "amountKzt" DECIMAL(12,2) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "milestone" INTEGER NOT NULL,
    "amountKzt" DECIMAL(12,2) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "status" "InspectionStatus" NOT NULL DEFAULT 'PENDING',
    "clinicName" TEXT,
    "reportUrl" TEXT,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "reasonCode" TEXT NOT NULL,
    "moderatorDecision" TEXT,
    "resolutionNote" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeEvidence" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "listingId" TEXT,
    "orderId" TEXT,
    "moderatorId" TEXT,
    "caseType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "riskSnapshot" JSONB,
    "decision" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateCode" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "RefreshToken"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "Listing_sellerId_status_createdAt_idx" ON "Listing"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Listing_status_city_priceKzt_createdAt_idx" ON "Listing"("status", "city", "priceKzt", "createdAt");

-- CreateIndex
CREATE INDEX "Listing_breed_status_createdAt_idx" ON "Listing"("breed", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ListingMedia_listingId_createdAt_idx" ON "ListingMedia"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingDocument_listingId_docType_createdAt_idx" ON "ListingDocument"("listingId", "docType", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentVerification_documentId_createdAt_idx" ON "DocumentVerification"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentVerification_moderatorId_createdAt_idx" ON "DocumentVerification"("moderatorId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_listingId_idx" ON "Order"("listingId");

-- CreateIndex
CREATE INDEX "Order_buyerId_status_createdAt_idx" ON "Order"("buyerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_sellerId_status_createdAt_idx" ON "Order"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_id_idx" ON "Order"("status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowTransaction_idempotencyKey_key" ON "EscrowTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EscrowTransaction_orderId_createdAt_idx" ON "EscrowTransaction"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "EscrowTransaction_txType_createdAt_idx" ON "EscrowTransaction"("txType", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_orderId_status_idx" ON "Payout"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_orderId_milestone_key" ON "Payout"("orderId", "milestone");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_orderId_key" ON "Inspection"("orderId");

-- CreateIndex
CREATE INDEX "Inspection_buyerId_status_deadlineAt_idx" ON "Inspection"("buyerId", "status", "deadlineAt");

-- CreateIndex
CREATE INDEX "Inspection_status_deadlineAt_idx" ON "Inspection"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_orderId_key" ON "Dispute"("orderId");

-- CreateIndex
CREATE INDEX "Dispute_status_openedAt_idx" ON "Dispute"("status", "openedAt");

-- CreateIndex
CREATE INDEX "Dispute_openedById_openedAt_idx" ON "Dispute"("openedById", "openedAt");

-- CreateIndex
CREATE INDEX "DisputeEvidence_disputeId_createdAt_idx" ON "DisputeEvidence"("disputeId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationCase_status_createdAt_idx" ON "ModerationCase"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationCase_caseType_status_idx" ON "ModerationCase"("caseType", "status");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_status_nextRetryAt_idx" ON "Notification"("status", "nextRetryAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMedia" ADD CONSTRAINT "ListingMedia_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingDocument" ADD CONSTRAINT "ListingDocument_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVerification" ADD CONSTRAINT "DocumentVerification_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ListingDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVerification" ADD CONSTRAINT "DocumentVerification_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowTransaction" ADD CONSTRAINT "EscrowTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeEvidence" ADD CONSTRAINT "DisputeEvidence_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

