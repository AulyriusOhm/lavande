import { allTeamMembers } from "@/lib/team";
import { usePrefs } from "@/lib/prefs";

export function TeamDatalist({ id }: { id: string }) {
  const prefs = usePrefs();
  return (
    <datalist id={id}>
      {allTeamMembers(prefs).map((member) => (
        <option key={`${member.scope}:${member.name}`} value={member.name} />
      ))}
    </datalist>
  );
}
