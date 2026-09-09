import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // Seed initial Yesp applications
  const apps = [
    { name: "Yesp One", slug: "yesp-one" },
    { name: "Yesp Studio", slug: "yesp-studio" },
  ];

  for (const app of apps) {
    await db.application.upsert({
      where: { slug: app.slug },
      create: app,
      update: { name: app.name },
    });
    console.log(`Seeded application: ${app.slug}`);
  }

  // Seed Yesp One OAuth client (dev)
  const yespOne = await db.application.findUnique({ where: { slug: "yesp-one" } });
  if (yespOne) {
    await db.oAuthClient.upsert({
      where: { clientId: "yesp-one-dev" },
      create: {
        applicationId: yespOne.id,
        clientId: "yesp-one-dev",
        redirectUris: ["http://localhost:3000/auth/callback"],
        allowedScopes: ["openid", "profile", "email"],
      },
      update: {},
    });
    console.log("Seeded OAuth client: yesp-one-dev");
  }
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
