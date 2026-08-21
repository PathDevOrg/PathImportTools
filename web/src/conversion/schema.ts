import { schemaFile } from "@aura-importer/aura-schema";
import sql from "../../../packages/aura-schema/V13_schema.sql?raw";

export const pathSchema = { ...schemaFile, sql };
