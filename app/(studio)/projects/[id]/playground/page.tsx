import { Playground } from "@/components/playground/playground";

export default async function PlaygroundPage({ params }: PageProps<"/projects/[id]/playground">) {
  const { id } = await params;
  return <Playground projectId={id} />;
}
