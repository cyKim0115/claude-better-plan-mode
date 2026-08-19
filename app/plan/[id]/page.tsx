import PlanBoard from "@/components/PlanBoard";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanBoard planId={id} />;
}
