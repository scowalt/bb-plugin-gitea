import { z } from "zod";

export const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
export const repositorySchema = z.string().regex(repositoryPattern);
