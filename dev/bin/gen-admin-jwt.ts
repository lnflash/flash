// This script generates an Admin JSON Web Token (JWT) using the 'jsonwebtoken' package.

// Usage: ts-node gen-test-jwt.ts

import jsonwebtoken from "jsonwebtoken"

const ADMIN_JWT_SECRET = process.env.ERPNEXT_JWT_SECRET || "not-so-secret"

function genAdminToken(): string {
  // Create admin JWT payload with required fields
  const payload = {
    userId: "admin-test-user",
    roles: ["Accounts Manager"], // Required role for admin access
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // Expires in 24 hours
  }

  // Sign the token with the admin secret
  const token = jsonwebtoken.sign(payload, ADMIN_JWT_SECRET, {
    algorithm: "HS256",
  })

  return token
}

function main() {
  const adminToken = genAdminToken()
  console.log("\n=== Admin JWT Token ===")
  console.log("Token:", adminToken)
  console.log("\nTo use this token, add it to your GraphQL request headers:")
  console.log("Authorization: Bearer", adminToken)
  console.log("\nExample curl command:")
  console.log(`curl -X POST http://localhost:4001/graphql \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${adminToken}" \\
  -d '{"query":"{ invitesList { edges { node { id contact status } } } }"}'`)
}

main()
