import { Prisma } from "@prisma/client";

export function isPrismaConnectionPoolError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2024" || error.code === "P1001" || error.code === "P1017")
  );
}
