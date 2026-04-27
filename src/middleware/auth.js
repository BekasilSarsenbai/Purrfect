const { prisma } = require("../config/prisma");
const { verifyAccessToken } = require("../services/token-service");

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Missing bearer token" });
    }

    const token = authHeader.replace("Bearer ", "");
    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, status: true, displayName: true, trustScore: true },
    });

    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "User is not active" });
    }

    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ code: "UNAUTHORIZED", message: "Access token is invalid or expired" });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ code: "FORBIDDEN", message: "Insufficient role permissions" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRoles };
