import { internal } from "./_generated/api";
import { query } from "./_generated/server";

//Get User Balances
export const getUserBalances = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    /*  ------------------- 1-to-1 expenses (no groupId) ------------------- */
    //  Filter expenses to only include one-on-one expenses (not group expenses)
    //  where the current user is either the payer or in the splits
    const expenses = (await ctx.db.query("expenses").collect()).filter(
      (e) =>
        !e.groupId && //1-to-1 only
        (e.paidByUserId === user._id ||
          e.splits.some((s) => s.userId === user._id))
    );

    let youOwe = 0; // Total amount users owes other
    let youAreOwed = 0; // Total amount others owe the user
    const balanceByUser = {}; // Detailed breakdown per user // Process each expense to calculate balance

    for (const e of expenses) {
      const isPayer = e.paidByUserId === user._id;
      const mySplit = e.splits.find((s) => s.userId === user._id);

      if (isPayer) {
        for (const s of e.splits) {
          // Skip user's own split or already paid splits
          if (s.userId === user._id || s.paid) continue;

          // Add to amount owed to the user
          youAreOwed += s.amount;

          (balanceByUser[s.userId] ??= { owed: 0, owing: 0 }).owed += s.amount;
        }
      } else if (mySplit && !mySplit.paid) {
        // Someone else paid and user hasn't paid their split
        youOwe += mySplit.amount;

        (balanceByUser[e.paidByUserId] ??= { owed: 0, owing: 0 }).owed +=
          mySplit.amount;
      }
    }

    /*  ------------------- 1-to-1 expenses (no groupId) ------------------- */
    // Get settlements that directly involve the current user
    const settlements = (await ctx.db.query("settlements").collect()).filter(
      (s) =>
        !s.groupId &&
        (s.paidByUserId === user._id || s.receivedByUserId === user._id)
    );

    for ( const s of settlements) {
      if (s.paidByUserId === user._id) {
        // User paid someone else -> reduces what user owes
        youOwe -= s.amount;
        (balanceByUser[s.receivedByUserId] ??= { owed: 0, owing: 0 }).owing -=
          s.amount;
      } else {
        // Someone paid the user -> reduces what they owe the user
        youAreOwed -= s.amount;
        (balanceByUser[s.paidByUserId] ??= { owed: 0, owing: 0 }).owed -=
          s.amount;
      }
    }

    //  build lists for UI
    const youOweList = []; // List of people user owes money to
    const youAreOwedByList = []; // List of peopl who owes the user

    for (const [uid, { owed, owing }] of Object.entries(balanceByUser)) {
      const net = owed - owing; // Calculate net balance
      if (net === 0) continue; // Skip if balanced

      // Get user details
      const counterpart = await ctx.db.get(uid);
      const base = {
        userId: uid,
        name: counterpart?.name ?? "Unknown",
        imageUrl: counterpart?.imageUrl,
        amount: Math.abs(net),
      };

      net > 0 ? youAreOwedByList.push(base) : youOweList.push(base);
    }

    youOweList.sort((a, b) => b.amount - a.amount);
    youAreOwedByList.sort((a, b) => b.amount - a.amount);

    return {
      youOwe, // Total amount user owes
      youAreOwed, // Total amount owed to user
      totalBalance: youAreOwed - youOwe, // Net Balance
      oweDetails: { youOwe: youOweList, youAreOwedBy: youAreOwedByList }, // Detailed lists
    };
  },
});

export const getTotalSpent = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    // Get current year and its start timestamp
    const currentYear = new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1).getTime();

    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_date", (q) => q.gte("date", startOfYear))
      .collect();

    // Filter expenses to only those where the user is involved
    const userExpenses = expenses.filter(
      (expense) =>
        expense.paidByUserId === user._id ||
        expense.splits?.some((split) => split.userId == user._id)
    );

    let totalSpent = 0;

    userExpenses.forEach((expense) => {
      const userSplit = expense.splits.find(
        (split) => split.userId === user._id
      );

      if (userSplit) totalSpent += userSplit.amount;
    });

    return totalSpent;
  },
});

export const getMonthlySpending = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    // Get current year and its start timestamp
    const currentYear = new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1).getTime();

    // Get all expenses for current year
    const allExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_date", (q) => q.gte("date", startOfYear))
      .collect();

    const userExpenses = allExpenses.filter(
      (expense) =>
        expense.paidByUserId === user._id ||
        expense.splits.some((split) => split.userId == user._id)
    );

    const monthlyTotals = {};

    for (let i = 0; i < 12; i++) {
      const monthDate = new Date(currentYear, i, 1);
      monthlyTotals[monthDate.getTime()] = 0;
    }

    userExpenses.forEach((expense) => {
      const date = new Date(expense.date);
      const monthStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        1
      ).getTime();

      const userSplit = expense.splits.find(
        (split) => split.userId === user._id
      );

      if (userSplit) {
        monthlyTotals[monthStart] =
          (monthlyTotals[monthStart] || 0) + userSplit.amount;
      }
    });

    const result = Object.entries(monthlyTotals).map(([month, total]) => ({
      month: parseInt(month),
      total,
    }));

    result.sort((a, b) => a.month - b.month);

    return result;
  },
});

export const getUserGroups = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    // Get all groups form the database
    const allGroups = await ctx.db.query("groups").collect();

    // Filter to only include groups where the user is a member
    const groups = allGroups.filter((group) =>
      group.members.some((member) => member.userId === user._id)
    );

    const enchancedGroups = await Promise.all(
      groups.map(async (group) => {
        // Get all expenses for this specific group
        const expenses = await ctx.db
          .query("expenses")
          .withIndex("by_group", (q) => q.eq("groupId", group._id))
          .collect();

        let balance = 0;

        // Calculate balance from expenses
        expenses.forEach((expense) => {
          if (expense.paidByUserId === user._id) {
            // User paid for the expense - other may owe them
            expense.splits.forEach((split) => {
              // Add amount others owe to the user (excluding user's own split and paid splits)
              if (split.userId !== user._id && !split.paid) {
                balance += split.amount;
              }
            });
          } else {
            // Someone else paid - user may owe them
            const userSplit = expense.splits.find(
              (split) => split.userId === user._id
            );

            // Subtract amounts the user owes others
            if (userSplit && !userSplit.paid) {
              balance -= userSplit.amount;
            }
          }
        });

        // Apply settlements to adjust the balance
        const settlements = await ctx.db
          .query("settlements")
          .filter((q) =>
            q.and(
              q.eq(q.field("groupId"), group._id),
              q.or(
                q.eq(q.field("paidByUserId"), user._id),
                q.eq(q.field("receivedByUserId"), user._id)
              )
            )
          )
          .collect();

        settlements.forEach((settlement) => {
          if (settlement.paidByUserId === user._id) {
            // User paid someone in the group - increase user's balance
            balance += settlement.amount;
          } else {
            // Someone paid the user - decreases user's balance
            balance -= settlement.amount;
          }
        });

        return {
          ...group,
          id: group._id,
          balance,
        };
      })
    );

    return enchancedGroups;
  },
});
