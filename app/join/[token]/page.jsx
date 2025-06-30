// app/join/[token]/page.jsx
"use client";

import { use } from "react"; 
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvex } from "convex/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useUser } from "@clerk/nextjs";

export default function JoinGroupPage({ params }) {
  const { token } = use(params);
  const router = useRouter();
  const convex = useConvex();
  const { isSignedIn } = useUser();
  const joinGroup = useMutation(api.groups.joinGroupByToken);

  useEffect(() => {
    const join = async () => {
      if (!isSignedIn) {
        router.push(`/sign-in?redirect_url=/join/${token}`);
        return;
      }

      try {
        const groupId = await joinGroup({ token });
        router.push(`/groups/${groupId}`);
      } catch (err) {
        console.error("Failed to join group:", err);
        router.push("/dashboard");
      }
    };

    join();
  }, [isSignedIn, joinGroup, token, router]);

  return <p className="text-center py-10">Joining group...</p>;
}
