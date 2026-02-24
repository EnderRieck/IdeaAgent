import { z } from "zod";
import venueRegistry from "../../../data/venues/registry.json";
import type { NativeTool } from "../../../core/native-tool";

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

export const venueSearchTool: NativeTool = {
  name: "venue-search",
  description: "从本地注册表中搜索顶级学术会议和期刊。",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    const rows = (venueRegistry.venues as Venue[]).filter((row) => {
      const matchKeyword = input.keyword
        ? `${row.id} ${row.name}`.toLowerCase().includes(input.keyword.toLowerCase())
        : true;
      const matchArea = input.area ? row.area.toLowerCase() === input.area.toLowerCase() : true;
      return matchKeyword && matchArea;
    });

    return {
      value: JSON.stringify(rows.slice(0, input.limit ?? 20)),
    };
  },
};
