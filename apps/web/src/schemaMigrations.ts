import v1 from "../../../packages/aura-schema/migrations/V1_schema.sql?raw";
import v2 from "../../../packages/aura-schema/migrations/V2_timeline_view.sql?raw";
import v3 from "../../../packages/aura-schema/migrations/V3_optimization.sql?raw";
import v4 from "../../../packages/aura-schema/migrations/V4_device_motion.sql?raw";
import v5 from "../../../packages/aura-schema/migrations/V5_refined_tracks.sql?raw";
import v6 from "../../../packages/aura-schema/migrations/V6_estimated_quality.sql?raw";
import v7 from "../../../packages/aura-schema/migrations/V7_stay_name_rules.sql?raw";
import v8 from "../../../packages/aura-schema/migrations/V8_timeline_query_indexes.sql?raw";
import v9 from "../../../packages/aura-schema/migrations/V9_move_mode_decisions.sql?raw";

export const schemaMigrations = [
  { version: 1, name: "V1_schema.sql", sql: v1 },
  { version: 2, name: "V2_timeline_view.sql", sql: v2 },
  { version: 3, name: "V3_optimization.sql", sql: v3 },
  { version: 4, name: "V4_device_motion.sql", sql: v4 },
  { version: 5, name: "V5_refined_tracks.sql", sql: v5 },
  { version: 6, name: "V6_estimated_quality.sql", sql: v6 },
  { version: 7, name: "V7_stay_name_rules.sql", sql: v7 },
  { version: 8, name: "V8_timeline_query_indexes.sql", sql: v8 },
  { version: 9, name: "V9_move_mode_decisions.sql", sql: v9 }
];
