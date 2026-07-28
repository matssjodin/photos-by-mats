/**
 * Seed a believable demo venue: "Strandhotellet".
 *
 * - 3 zones (POOL / OUTDOOR / INDOOR)
 * - 2 stations (Bar, Kök) + a NO_PREP passthrough used by snacks
 * - ~10 drinks (4 age-checked), ~8 dishes, ~4 snacks
 * - 4 staff, all with PIN 1234
 * - a couple of open sessions with existing orders so the views aren't empty
 *
 * Run with: npm run seed
 */
import { PrismaClient, ZoneType, StationType, StaffRole, TicketStatus, OrderStatus } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const prisma = new PrismaClient();

// URL-safe base32 token (Crockford-ish), 10 chars. Random, never sequential.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function placeToken(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += B32[bytes[i] % B32.length];
  return out;
}

// Demo-only PIN hashing. Real auth hardening (salt+slow hash) comes later;
// kept as a single function so it's trivial to swap.
function hashPin(pin: string): string {
  return createHash("sha256").update(`demo-pin:${pin}`).digest("hex");
}

async function main() {
  // Idempotent-ish demo seed: wipe in FK-safe order, then recreate.
  await prisma.cancellation.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.session.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.menuCategory.deleteMany();
  await prisma.place.deleteMany();
  await prisma.zone.deleteMany();
  await prisma.station.deleteMany();
  await prisma.staffUser.deleteMany();
  await prisma.venue.deleteMany();

  const venue = await prisma.venue.create({
    data: { name: "Strandhotellet", timezone: "Europe/Stockholm" },
  });

  // Stations
  const bar = await prisma.station.create({
    data: { venueId: venue.id, name: "Bar", type: StationType.BAR },
  });
  const kitchen = await prisma.station.create({
    data: { venueId: venue.id, name: "Kök", type: StationType.KITCHEN },
  });
  const passthrough = await prisma.station.create({
    data: { venueId: venue.id, name: "Servering", type: StationType.NO_PREP },
  });

  // Zones + places
  const poolZone = await prisma.zone.create({
    data: { venueId: venue.id, name: "Poolområde A", type: ZoneType.POOL },
  });
  const barZone = await prisma.zone.create({
    data: { venueId: venue.id, name: "Poolbaren", type: ZoneType.OUTDOOR },
  });
  const restaurantZone = await prisma.zone.create({
    data: { venueId: venue.id, name: "Restaurangen", type: ZoneType.INDOOR },
  });

  async function makePlaces(zoneId: string, labelPrefix: string, count: number) {
    for (let i = 1; i <= count; i++) {
      await prisma.place.create({
        data: {
          venueId: venue.id,
          zoneId,
          label: `${labelPrefix} ${i}`,
          token: placeToken(),
        },
      });
    }
  }
  await makePlaces(poolZone.id, "Solstol", 12);
  await makePlaces(barZone.id, "Barbord", 6);
  await makePlaces(restaurantZone.id, "Bord", 10);

  // Menu categories
  const catDrinks = await prisma.menuCategory.create({
    data: { venueId: venue.id, name: "Drycker", sortOrder: 1 },
  });
  const catFood = await prisma.menuCategory.create({
    data: { venueId: venue.id, name: "Mat", sortOrder: 2 },
  });
  const catSnacks = await prisma.menuCategory.create({
    data: { venueId: venue.id, name: "Snacks", sortOrder: 3 },
  });

  // Drinks (bar) — 4 require age check
  const drinks = [
    { name: "Stor stark", price: 8900, age: true },
    { name: "Rosé (glas)", price: 11500, age: true },
    { name: "Aperol Spritz", price: 13500, age: true },
    { name: "Gin & Tonic", price: 14500, age: true },
    { name: "Alkoholfri öl", price: 6900, age: false },
    { name: "Läsk", price: 3900, age: false },
    { name: "Sparkling water", price: 3500, age: false },
    { name: "Iskaffe", price: 4900, age: false },
    { name: "Färskpressad juice", price: 5900, age: false },
    { name: "Milkshake", price: 6500, age: false },
  ];
  for (const d of drinks) {
    await prisma.menuItem.create({
      data: {
        venueId: venue.id,
        categoryId: catDrinks.id,
        stationId: bar.id,
        name: d.name,
        priceCents: d.price,
        requiresAgeCheck: d.age,
      },
    });
  }

  // Food (kitchen)
  const dishes = [
    ["Club sandwich", 15900],
    ["Caesarsallad", 16900],
    ["Cheeseburgare & pommes", 18900],
    ["Räkmacka", 17900],
    ["Fish & chips", 18500],
    ["Margheritapizza", 15500],
    ["Nachos", 12900],
    ["Dagens fisk", 22900],
  ] as const;
  for (const [name, price] of dishes) {
    await prisma.menuItem.create({
      data: { venueId: venue.id, categoryId: catFood.id, stationId: kitchen.id, name, priceCents: price },
    });
  }

  // Snacks (no prep)
  const snacks = [
    ["Portion pommes", 6900],
    ["Chips", 3900],
    ["Nötter", 4500],
    ["Glass", 4900],
  ] as const;
  for (const [name, price] of snacks) {
    await prisma.menuItem.create({
      data: { venueId: venue.id, categoryId: catSnacks.id, stationId: passthrough.id, name, priceCents: price },
    });
  }

  // Staff (PIN 1234 for all)
  const pin = hashPin("1234");
  await prisma.staffUser.createMany({
    data: [
      { venueId: venue.id, name: "Bea Bartender", role: StaffRole.BARTENDER, pinHash: pin },
      { venueId: venue.id, name: "Karl Kock", role: StaffRole.KITCHEN, pinHash: pin },
      { venueId: venue.id, name: "Rita Runner", role: StaffRole.RUNNER, pinHash: pin },
      { venueId: venue.id, name: "Mona Manager", role: StaffRole.MANAGER, pinHash: pin },
    ],
  });

  // A couple of open sessions with existing orders so views aren't empty.
  const poolPlaces = await prisma.place.findMany({ where: { zoneId: poolZone.id }, orderBy: { label: "asc" } });
  const restaurantPlaces = await prisma.place.findMany({ where: { zoneId: restaurantZone.id }, orderBy: { label: "asc" } });
  const beer = await prisma.menuItem.findFirstOrThrow({ where: { name: "Stor stark" } });
  const fries = await prisma.menuItem.findFirstOrThrow({ where: { name: "Portion pommes" } });
  const burger = await prisma.menuItem.findFirstOrThrow({ where: { name: "Cheeseburgare & pommes" } });

  // Session 1: pool chair with a beer (bar ticket) + fries (no-prep ticket).
  const s1 = await prisma.session.create({
    data: { placeId: poolPlaces[0].id, deliveryLocation: "Zon A, nära baren" },
  });
  const o1 = await prisma.order.create({
    data: {
      sessionId: s1.id,
      status: OrderStatus.RECEIVED,
      items: {
        create: [
          { menuItemId: beer.id, quantity: 1, unitPriceCents: beer.priceCents },
          { menuItemId: fries.id, quantity: 1, unitPriceCents: fries.priceCents },
        ],
      },
    },
  });
  await prisma.ticket.create({ data: { orderId: o1.id, stationId: bar.id, status: TicketStatus.RECEIVED } });
  await prisma.ticket.create({ data: { orderId: o1.id, stationId: passthrough.id, status: TicketStatus.RECEIVED } });

  // Session 2: restaurant table with a burger (kitchen ticket).
  const s2 = await prisma.session.create({ data: { placeId: restaurantPlaces[0].id } });
  const o2 = await prisma.order.create({
    data: {
      sessionId: s2.id,
      status: OrderStatus.IN_PROGRESS,
      items: { create: [{ menuItemId: burger.id, quantity: 2, unitPriceCents: burger.priceCents }] },
    },
  });
  await prisma.ticket.create({ data: { orderId: o2.id, stationId: kitchen.id, status: TicketStatus.IN_PROGRESS } });

  const placeCount = await prisma.place.count();
  console.log(`Seeded venue "${venue.name}" with ${placeCount} places, menu, staff (PIN 1234), and 2 open sessions.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
