function notFoundHandler(req, res) {
  return res.status(404).json({
    code: "NOT_FOUND",
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

function mapPrismaError(err) {
  if (err.code === "P2002") {
    return {
      status: 409,
      code: "CONFLICT",
      message: "Resource with this unique value already exists",
      details: err.meta || null,
    };
  }
  if (err.code === "P2025") {
    return {
      status: 404,
      code: "NOT_FOUND",
      message: err.meta?.cause || "Record not found",
      details: null,
    };
  }
  if (err.code === "P2003") {
    return {
      status: 409,
      code: "CONFLICT",
      message: "Foreign key constraint failed",
      details: err.meta || null,
    };
  }
  return null;
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const prismaMapped = err && typeof err === "object" && err.code && err.code.startsWith("P") ? mapPrismaError(err) : null;
  if (prismaMapped) {
    return res.status(prismaMapped.status).json({
      code: prismaMapped.code,
      message: prismaMapped.message,
      details: prismaMapped.details,
    });
  }

  const status = err.status || 500;
  const code = err.code || "INTERNAL_ERROR";
  const message = err.message || "Unexpected server error";

  return res.status(status).json({
    code,
    message,
    details: err.details || null,
  });
}

module.exports = { notFoundHandler, errorHandler };
