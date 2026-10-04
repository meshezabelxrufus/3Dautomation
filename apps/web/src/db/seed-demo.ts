/**
 * Development-only demo data: one project in every workflow state, built through the
 * real workflow operations (so all database rules apply). Images are placeholder
 * renders from /public/demo. Re-running replaces previous demo projects only.
 *
 *   pnpm --filter @three-d/web db:seed:demo
 */
import { like } from "drizzle-orm";
import { Pool } from "pg";
import { createDb, type Database } from "./client";
import { projects } from "./schema";
import { VIEW_TYPES } from "../server/domain/workflow-states";
import * as wf from "../server/workflow/workflow";

const DEMO_SUFFIX = " · Demo";
const img = (name: string) => `/demo/${name}.svg`;
const VIEW_IMAGES = { FRONT: img("view-front"), BACK: img("view-back"), LEFT: img("view-left"), RIGHT: img("view-right") };

const WOLF_BRIEF =
  "I want a futuristic mechanical wolf bust with sharp geometric armor, collectible statue proportions and an aggressive expression.";

type ConceptSeed = { title: string; description: string; image?: string; direction?: string; features?: string[]; materials?: string[] };

const WOLF_CONCEPTS: ConceptSeed[] = [
  {
    title: "Alpha Plate",
    description: "Layered armor plates follow the skull, with a snarling jaw and glowing visor-like eyes.",
    image: img("wolf-concept-1"),
    direction: "Hard-surface sci-fi, heavy plating, museum-statue presence",
    features: ["Interlocking cheek plates", "Exposed hydraulic neck", "Visor eyes"],
    materials: ["Resin, gunmetal paint", "Brass edge highlights"],
  },
  {
    title: "Ember Hunter",
    description: "Leaner, more organic silhouette with heat-vent slits along the snout.",
    image: img("wolf-concept-2"),
    direction: "Organic-mechanical hybrid",
    features: ["Heat vents", "Swept-back ears"],
    materials: ["Resin, copper patina"],
  },
  {
    title: "Glacier Sentinel",
    description: "Tall, faceted ears and crystalline armor shards. Calm but menacing.",
    image: img("wolf-concept-3"),
    features: ["Crystalline shards", "Tall faceted ears"],
    materials: ["Translucent resin inserts"],
  },
  {
    title: "Monolith",
    description: "Abstract low-poly interpretation; the wolf reads only at a distance.",
    image: img("wolf-concept-4"),
    features: ["Low-poly facets"],
    materials: ["Matte white PLA"],
  },
];

async function conceptsReview(db: Database, name: string, client: string, brief: string, seeds: ConceptSeed[]) {
  const p = await wf.createProject(db, { projectName: name, clientName: client + DEMO_SUFFIX, designBrief: brief });
  await wf.startConceptGeneration(db, p.id, { requestedCount: seeds.length });
  const ids: string[] = [];
  for (const s of seeds) {
    const c = await wf.addConcept(db, p.id, {
      title: s.title,
      description: s.description,
      creativeDirection: s.direction,
      keyFeatures: s.features,
      materials: s.materials,
      generationPrompt: `${s.title}: ${s.description}`,
      imageUrl: s.image,
    });
    ids.push(c.id);
  }
  await wf.completeConceptGeneration(db, p.id);
  return { projectId: p.id, conceptIds: ids };
}

async function toViews(db: Database, name: string, client: string) {
  const { projectId, conceptIds } = await conceptsReview(db, name, client, WOLF_BRIEF, WOLF_CONCEPTS.slice(0, 3));
  await wf.selectConcept(db, conceptIds[0]!);
  await wf.rejectConcept(db, conceptIds[2]!);
  const rev = await wf.startRefinement(db, conceptIds[0]!, { clientFeedback: "Sharper ear spikes and a more aggressive brow. Keep the plating." });
  await wf.completeRevision(db, rev.id, {
    imageUrl: img("wolf-revision-1"),
    interpretedInstruction: { changes: ["Ear spikes +40% height", "Brow angled down 15°"], preserve: ["Armor plating", "Pose"] },
    generationPrompt: "edit: sharper ears, aggressive brow",
  });
  const pending = await wf.beginFinalization(db, projectId, { conceptId: conceptIds[0]!, revisionId: rev.id });
  await wf.confirmFinalization(db, pending.id);
  const views = await wf.startViewGeneration(db, projectId);
  return { projectId, views };
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("db:seed:demo refuses to run in production");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, max: 2 });
  const db = createDb(pool);

  try {
    const removed = await db.delete(projects).where(like(projects.clientName, `%${DEMO_SUFFIX}`)).returning({ id: projects.id });
    if (removed.length) console.log(`seed: removed ${removed.length} previous demo projects`);

    // DRAFT (empty workspace)
    await wf.createProject(db, {
      projectName: "Dragon Chess Set",
      clientName: "Kingsmoor Games" + DEMO_SUFFIX,
      designBrief: "A 32-piece chess set where each side is a dragon clan. Kings are coiled dragons, pawns are hatchlings. Printable without supports.",
    });

    // GENERATING_CONCEPTS: 1 of 4 ready, 1 in progress
    {
      const p = await wf.createProject(db, {
        projectName: "Faceted Planter",
        clientName: "Greenhaus" + DEMO_SUFFIX,
        designBrief: "A desktop planter with a faceted, crystal-like exterior and a hidden drainage tray. Should feel premium in matte stone colors.",
      });
      await wf.startConceptGeneration(db, p.id, { requestedCount: 4 });
      await wf.addConcept(db, p.id, { title: "Geode", description: "Split-geode silhouette with a raw inner face.", imageUrl: img("vase-concept-2") });
      await wf.addConcept(db, p.id, { title: "Terrace", description: "Stepped terraces that catch light like a quarry." });
    }

    // CONCEPT_REVIEW with selection, rejection and a revision
    {
      const { conceptIds } = await conceptsReview(
        db,
        "Orbit Desk Lamp",
        "Lumen & Co",
        "A minimalist desk lamp with an orbiting ring arm, printable in two parts, warm and calm, for a design-store shelf.",
        [
          { title: "Saturn", description: "A sphere shade wrapped by a single tilted ring that doubles as the arm.", image: img("lamp-concept-1"), features: ["Ring arm", "Weighted base"], materials: ["PLA", "Brass insert"] },
          { title: "Eclipse", description: "Flatter ring, steeper tilt; light spills from the ring's inner edge.", image: img("lamp-concept-2") },
          { title: "Amphora", description: "Classical vase body with a glowing neck.", image: img("lamp-concept-3") },
        ],
      );
      await wf.selectConcept(db, conceptIds[0]!);
      await wf.rejectConcept(db, conceptIds[2]!, "Too classical for the brand");
      const rev = await wf.startRefinement(db, conceptIds[1]!, { clientFeedback: "Make the ring thinner and the finish matte." });
      await wf.completeRevision(db, rev.id, {
        imageUrl: img("lamp-concept-2"),
        interpretedInstruction: { changes: ["Ring thickness -30%", "Matte finish"], preserve: ["Tilt angle"] },
        generationPrompt: "edit: thinner ring, matte",
      });
    }

    // REFINING
    {
      const { conceptIds } = await conceptsReview(db, "Samurai Helmet Display", "Ronin Replicas", WOLF_BRIEF.replace("mechanical wolf bust", "samurai kabuto helmet"), WOLF_CONCEPTS.slice(1, 4));
      await wf.startRefinement(db, conceptIds[0]!, { clientFeedback: "Add a crescent maedate crest and darker lacquer." });
    }

    // FINALIZING
    {
      const { projectId, conceptIds } = await conceptsReview(db, "Ceramic Owl Lamp", "Nightjar Studio", "A ceramic-look owl table lamp, round and friendly, with light through the eyes.", [
        { title: "Barn Owl", description: "Heart-shaped face, soft facets.", image: img("vase-concept-1") },
        { title: "Snowy", description: "Rounder body, tiny beak.", image: img("wolf-concept-4") },
      ]);
      await wf.beginFinalization(db, projectId, { conceptId: conceptIds[0]! });
    }

    // GENERATING_VIEWS: 2 of 4 ready
    {
      const { views } = await toViews(db, "Art Deco Bookends", "Gatsby Interiors");
      for (const v of views.slice(0, 2)) await wf.recordViewGenerated(db, v.id, { imageUrl: VIEW_IMAGES[v.viewType] });
    }

    // VIEW_REVIEW: all ready, front approved
    {
      const { projectId, views } = await toViews(db, "Mechanical Wolf Bust", "Northwind Collectibles");
      for (const v of views) await wf.recordViewGenerated(db, v.id, { imageUrl: VIEW_IMAGES[v.viewType] });
      await wf.completeViewGeneration(db, projectId);
      await wf.approveView(db, views.find((v) => v.viewType === "FRONT")!.id);
    }

    // COMPLETED
    {
      const { projectId, views } = await toViews(db, "Koi Fountain Topper", "Still Water Gardens");
      for (const v of views) await wf.recordViewGenerated(db, v.id, { imageUrl: VIEW_IMAGES[v.viewType] });
      await wf.completeViewGeneration(db, projectId);
      for (const v of views) await wf.approveView(db, v.id);
      await wf.startDriveUpload(db, projectId);
      await wf.completeDriveUpload(db, projectId, {
        driveFileIds: Object.fromEntries(VIEW_TYPES.map((t) => [t, `demo-drive-${t.toLowerCase()}`])) as Record<(typeof VIEW_TYPES)[number], string>,
        driveFolderId: "demo-folder",
      });
    }

    // FAILED during view generation
    {
      const { projectId, views } = await toViews(db, "Retro Robot Figurine", "Tin Toy Works");
      await wf.recordViewGenerated(db, views[0]!.id, { imageUrl: VIEW_IMAGES.FRONT });
      await wf.markViewFailed(db, views[1]!.id, "Image provider timed out");
      await wf.failProject(db, projectId, { stage: "VIEWS", reason: "The image service timed out three times while generating the back view." });
    }

    console.log("seed: demo projects created");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("seed: failed", err);
  process.exit(1);
});
