import { z } from "zod";
import venueRegistry from "../../../data/venues/registry.json";
import type { Tool } from "../../../capabilities/tools/types";

const inputSchema = z.object({
  keyword: z.string().min(1).optional(),
  area: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20).optional(),
});

type Venue = {
  id: string;
  name: string;
  area: string;
};

export const venueSearchTool: Tool<z.infer<typeof inputSchema>, Venue[]> = {
  id: "venue-search",
  description: "Search top venues from local registry.",
  inputSchema,
  async execute(input) {
    const rows = (venueRegistry.venues as Venue[]).filter((row) => {
      const matchKeyword = input.keyword
        ? `${row.id} ${row.name}`.toLowerCase().includes(input.keyword.toLowerCase())
        : true;
      const matchArea = input.area ? row.area.toLowerCase() === input.area.toLowerCase() : true;
      return matchKeyword && matchArea;
    });

    return {
      ok: true,
      data: rows.slice(0, input.limit ?? 20),
    };
  },
};
