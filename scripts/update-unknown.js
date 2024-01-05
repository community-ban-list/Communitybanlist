import { connect } from 'scbl-lib/db';
import { Ban } from 'scbl-lib/db/models';
import { classifyBanReason } from 'scbl-lib/utils';

async function main() {
  await connect();
  const bans = await Ban.findAll({ where: { reason: 'unknown' } });
  console.log(`${bans.length} Unknown Bans To Classify`);
  for (const ban of bans) {
    const old = ban.reason;
    ban.reason = classifyBanReason(ban.rawReason, ban.rawNote);
    if (old !== ban.reason) {
      console.log(old, ban.reason);
      console.log(`[DEBUG] Updating Ban: ${ban.reason}`);
      await ban.save();
    }
  }
}

main();
