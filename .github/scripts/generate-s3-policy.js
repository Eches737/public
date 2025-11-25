#!/usr/bin/env node
const fs = require('fs')

const bucket = process.env.BUCKET
const mode = (process.env.MODE || 'SOURCEARN')

if (!bucket) {
  console.error('BUCKET env required')
  process.exit(1)
}

let policy
if (mode === 'SOURCEARN') {
  const acct = process.env.AWS_ACCOUNT_ID
  const dist = process.env.CLOUDFRONT_DISTRIBUTION_ID
  if (!acct || !dist) {
    console.error('AWS_ACCOUNT_ID and CLOUDFRONT_DISTRIBUTION_ID are required for SOURCEARN mode')
    process.exit(1)
  }
  policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowCloudFrontServicePrincipalReadOnly',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${acct}:distribution/${dist}` } }
      }
    ]
  }
} else {
  const oai = process.env.OAI_CANONICAL_USER_ID
  if (!oai) {
    console.error('OAI_CANONICAL_USER_ID is required for OAI mode')
    process.exit(1)
  }
  policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowCloudFrontOriginAccessIdentity',
        Effect: 'Allow',
        Principal: { CanonicalUser: oai },
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucket}/*`
      }
    ]
  }
}

fs.writeFileSync('/tmp/new-policy.json', JSON.stringify(policy, null, 2))
console.log('Wrote /tmp/new-policy.json:')
console.log(fs.readFileSync('/tmp/new-policy.json', 'utf8'))
