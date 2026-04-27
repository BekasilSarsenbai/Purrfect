function notFoundHandler(req, res) {
  return res.status(404).json({
    code: "NOT_FOUND",
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
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
