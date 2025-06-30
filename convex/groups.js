import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

export const getGroupExpenses = query({
    args: { groupId: v.id("groups")},
    handler : async (ctx, { groupId }) => {
        const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

        const group = await ctx.db.get(groupId);
        if (!group) throw new Error("Group not found");


        if (!group.members.some((m) => m.userId === currentUser._id))
            throw new Error("You are not a member of this group");
        
        const expenses = await ctx.db
            .query("expenses")
            .withIndex("by_group", (q) => q.eq("groupId", groupId))
            .collect();
        

        const settlements = await ctx.db
            .query("settlements")
            .filter((q) => q.eq(q.field("groupId"), groupId))
            .collect();

        
        // -------- member map -------- 
        const memberDetails = await Promise.all(
            group.members.map(async (m) => {
                const u = await ctx.db.get(m.userId);
                return {
                    id: u._id,
                    name: u.name,
                    imageUrl: u.imageUrl,
                    role: m.role,
                }
            })
        );

        const ids = memberDetails.map((m) => m.id);

        // Balance Calculation Setup
        // -----------------------
        // Intialize totals object to track overall balance for each user 
        // Fromat; { userId1: balance1, userId2: balance2 ...}

        const totals = Object.fromEntries(ids.map((id) => [id,0]));

        // Create a two-dimensional ledger to track who owes whom
        // ledger[A][B] = how much A owes B
        // Example for 3 user (user1, user2, user3);
        // ledger = {
        //      "user1" : { "user2": 0, "user3": 0},
        //      "user2" : { "user1": 0, "user3": 0},
        //      "user3" : { "user1": 0, "user2": 0}
        // }
        const ledger = {}

        ids.forEach((a) => {
            ledger[a] = {};
            ids.forEach((b) => {
                if (a != b) ledger[a][b] = 0;
            })
        });

        // Apply Expense to Balances 
        // ------------------------
        // Example:
        // - Expense 1: user1 paid $60, split equally among all 3 users ($20 each)
        // - After applying this expense: 
        //  - totals = {"user1": +40, "user2": -20, "user3": -20} 
        //  - ledger = {
        //      "user1" : { "user2": 0, "user3": 0},
        //      "user2" : { "user1": 20, "user3": 0},
        //      "user3" : { "user1": 20, "user2": 0}  
        //    }
        // - This means user2 owes user1 $20, and user3 owes user1 $20 

        for ( const exp of expenses) {
            const payer = exp.paidByUserId;
            
            for (const split of exp.splits) {
                // Skip if this is the payer's own split or if already paid
                if (split.userId === payer || split.paid) continue;

                const debtor = split.userId;
                const amt = split.amount;

                // Update totals: increase payer's balance, decrease debtor's balance
                totals[payer] += amt; // Payer gains credit
                totals[debtor] -= amt; // Debtor goes into debt

                ledger[debtor][payer] += amt;
            }
        }

        // Apply Settlement to Balances
        // ---------------------------
        // Example: 
        // - Settlement: user2 paid $10 to user1
        // - After applyinng this settlement:
        //  - totals = {"user1": +30, "user2": -10, "user3": -20} 
        //  - ledger = {
        //      "user1" : { "user2": 0, "user3": 0},
        //      "user2" : { "user1": 10, "user3": 0},
        //      "user3" : { "user1": 20, "user2": 0}  
        //    }
        // - This means user2 owes user1 $10, and user3 owes user1 $20 

        for ( const s of settlements ) {
            // Update totals: increase payer's balance, decrease receiver's balance
            totals[s.paidByUserId] += s.amount;
            totals[s.receivedByUserId] += s.amount;

            // Update ledger: reduce what the payer owes to the receiver
            ledger[s.paidByUserId][s.receivedByUserId] -= s.amount
        }


        // Simplify the Ledger (Debt Simplification)
        // ---------------------------------------
        // Example with a circular debt:
        // - Initial ledger:
        //   - userl owes uqer2 $10
        //   - user2 owes user3 $15
        //   - user3 owes userl $5
        // After simplification:
        //   - userl owes user2 $5
        //   - user2 owes user3 $15
        //   - user3 owes userl $0
        // This reduces the circular debt pattern
        ids.forEach( a => {
            ids.forEach((b) => {
                if (a >= b) return;

                // Calculate the net debt between two user
                const diff = ledger[a][b] - ledger[b][a];

                if (diff > 0) {
                    // User A owes User B (net)
                    ledger[a][b] = diff;
                    ledger[b][a] = 0;
                } else if (diff < 0) {
                    // User B owes User A (net)
                    ledger[b][a] = -diff;
                    ledger[a][b] = 0;
                } else {
                    // They're even
                    ledger[a][b] = ledger[b][a] = 0;
                }
            });
        });


        // Format Response Data
        // --------------------
        // Create a comprehensive balance objext for each member
        const balances = memberDetails.map(m =>({
            ...m,
            totalBalance: totals[m.id],
            owes: Object.entries(ledger[m.id])
                .filter(([,v]) => v > 0)
                .map(([to,amount]) => ({to, amount})),
            owedBy: ids
                .filter((other) => ledger[other][m.id] > 0)
                .map((other) => ({ from: other, amount: ledger[other][m.id]})),    
        }));

        const userLookupMap = {};
        memberDetails.forEach((member) => {
            userLookupMap[member.id] = member
        });


        return {
            // Group information
            group: {
                id: group._id,
                name: group.name,
                description: group.description,
                inviteToken: group.inviteToken,
            },
            members: memberDetails, // All group members with details
            expenses, // All expenses in this group
            settlements, // All settlements in this group
            balances, // Calculated balance info for each group
            userLookupMap // Quick lookup for user details
        };
    }
});


export const getGroupOrMembers = query({
    args: {
        groupId: v.optional(v.id("groups")),    // Optional - if provided, will return details for just this group
    },

    handler: async (ctx,args) => {
        const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

        // Get all groups where the user is a member
        const allGroups = await ctx.db.query("groups").collect();
        const userGroups = allGroups
            .filter((group) => group.members
            .some((member) => 
                member.userId === currentUser._id));


        if (args.groupId) {
            const selectedGroup = userGroups.find((group) => group._id === args.groupId);

            if (!selectedGroup) {
                throw new Error("Group not found or you're not a member");
            }

            const memberDetails = await Promise.all(
                selectedGroup.members.map(async (member) => {
                    const user = await ctx.db.get(member.userId);
                    if (!user) return null;

                    return {
                        id: user._id,
                        name: user.name,
                        email: user.email,
                        imageUrl: user.imageUrl,
                        role: member.role,
                    };
                })
            );


            const validMembers = memberDetails.filter((member) => member !== null);

            return {
                selectedGroup: {
                    id: selectedGroup._id,
                    name: selectedGroup.name,
                    description: selectedGroup.description,
                    createdBy: selectedGroup.createdBy,
                    members: validMembers,
                },
                groups: userGroups.map((group) => ({
                    id: group._id,
                    name: group.name,
                    description: group.description,
                    memberCount: group.members.length,
                }))
            };
        } else {
            // Just return the list of groups without member details
            return {
                selectedGroup: null,
                groups: userGroups.map((group) => ({
                    id: group._id,
                    name: group.name,
                    description: group.description,
                    memberCount: group.members.length,
                })),
            };
        }
    },
});


// Generate invite token
export const generateInviteToken = mutation({
    args: { groupId: v.id("groups") },
    handler: async (ctx, { groupId }) => {
      const user = await ctx.runQuery(internal.users.getCurrentUser);
      const group = await ctx.db.get(groupId);
      if (!group) throw new Error("Group not found");
  
      const isAdmin = group.members.find(
        (m) => m.userId === user._id && m.role === "admin"
      );
      if (!isAdmin) throw new Error("Only admin can generate invite link");
  
      const token = nanoid(10);
      await ctx.db.patch(groupId, { inviteToken: token });
      return token;
    },
  });
  
  // Join group by token
  export const joinGroupByToken = mutation({
    args: { token: v.string() },
    handler: async (ctx, { token }) => {
      const user = await ctx.runQuery(internal.users.getCurrentUser);
      const group = await ctx.db
        .query("groups")
        .filter((q) => q.eq(q.field("inviteToken"), token))
        .first();
  
      if (!group) throw new Error("Invalid invite link");
  
      const alreadyMember = group.members.some((m) => m.userId === user._id);
      if (alreadyMember) return group._id;
  
      await ctx.db.patch(group._id, {
        members: [
          ...group.members,
          {
            userId: user._id,
            role: "member",
            joinedAt: Date.now(),
          },
        ],
      });
  
      return group._id;
    },
  });