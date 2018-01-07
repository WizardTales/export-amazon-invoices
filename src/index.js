import chalk from 'chalk';
import commandLineArgs from 'command-line-args';
import fs from 'fs-extra';
import listOrders from './lib/listOrders';
import getOrderNumber from './lib/getOrderNumber';
import puppeteer from 'puppeteer';
import showUsageHints from './lib/showUsageHints';
import {log, logDetail, logError, logStatus} from './lib/log';

import argDefinitions from './lib/argDefinitions';
import selectors from './lib/selectors';

const args = commandLineArgs(argDefinitions);

if (!args.hasOwnProperty('email') || !args.hasOwnProperty('password')) {
  showUsageHints();
}

const resultsPerPage = 10;

// invoice links follow pattern 'Rechnung 1' or 'Rechnung oder Gutschrift 1'
const invoiceLinkRegex = /^Rechnung( oder Gutschrift)?s[0-9]{1,2}/;

const failedExports = [];

(async () => {
  // rimraf output dirs
  args.year.forEach(year => fs.remove(`./output/${year}`));

  // initialize browser
  const browser = await puppeteer.launch({
    headless: false,
  });
  const page = await browser.newPage();

  await page.setViewport({
    width: 1440,
    height: 900,
  });

  await page.goto(listOrders(), {waitUntil: 'load'});

  const requiresLogin = await page.evaluate(sel => document.querySelectorAll(sel).length > 0, selectors.login.form);
  if (requiresLogin) {
    logStatus(`Logging into Amazon account ${args.email}`);

    try {
      await page.type(selectors.login.email, args.email);
      await page.type(selectors.login.password, args.password);
      await page.click(selectors.login.submit);

      await page.waitForSelector(selectors.list.page);
    } catch (e) {
      logError(`Could not log in with\n  email     ${args.email}\n  password  ${args.password}`);
      process.exit();
    }
  }

  for (let ii = 0; ii < args.year.length; ii++) {
    let savedInvoices = 0;
    const year = args.year[ii];
    logStatus(`Exporting orders of ${year}`);

    const outputFolder = `./output/${year}/`;
    fs.mkdirs(outputFolder);

    await page.goto(listOrders(year, 0), {waitUntil: 'load'});

    const x = await page.$eval(selectors.list.numOrders, el => parseInt(el.innerText.split(' ')[0], 10));
    const numberOfOrders = Math.min(x, 3);
    logStatus(`Starting export of ${numberOfOrders} orders`);

    for (let i = 1, l = numberOfOrders; i <= l; i++) {
      const resultsPage = Math.ceil(i / resultsPerPage);

      const isFirstResultOnPage = i % resultsPerPage === 1;
      if (isFirstResultOnPage) {
        logStatus(`Loading results page ${resultsPage} of ${Math.ceil(numberOfOrders / 10)}`);

        const offset = resultsPage * resultsPerPage;
        await page.goto(listOrders(year, offset), {waitUntil: 'load'});
      }

      const orderNumber = getOrderNumber(i, year, numberOfOrders);
      logDetail(`Exporting invoice(s) for order ${orderNumber}`);

      // there is a hidden alert component at the top of the orders list,
      // so a selector using nth-child within the ordersContainer has to start at 2,
      // meaning we have to increase all orderIndex values by 1
      const orderIndex = i % resultsPerPage === 0 ? resultsPerPage + 1 : i % resultsPerPage + 1;

      try {
        const popoverTrigger = await page.$(
          `${selectors.list.order}:nth-of-type(${orderIndex}) ${selectors.list.popoverTrigger}`
        );
        await popoverTrigger.click();

        // FIXME: get actual download links
        await page.waitFor(4000); // give the popover content time to load
        // the popover ids start at 3 and Amazon increments them in the order the elements are clicked,
        // so the first opened popover has #a-popover-3, the next #a-popover-4, #a-popover-5 etc.
        const popoverLinks = await page.$$eval(
          `#a-popover-content-${orderIndex + 1} ${selectors.list.popoverLinks}`,
          el => {
            log('popoverLink', el.innerText, el.innerText.match(invoiceLinkRegex));
          }
        );

        // TODO: save invoice(s) into output folder

        savedInvoices++;
      } catch (e) {
        logError(`Failed to process order ${orderNumber}, orderIndex ${orderIndex}, page ${resultsPage}`);
        logError(e);

        const path = `${outputFolder}/FAILED__${orderNumber}.png`;
        await page.screenshot({
          fullPage: true,
          path,
        });
        failedExports.push(`Order ${orderNumber}, see screenshot ${path}`);
      }
    }

    logStatus(`${savedInvoices} invoices saved as PDF in folder /output/${year}`);
  }

  await browser.close();
  logStatus('Export complete');
  console.log(
    ' ',
    chalk.dim('Type'),
    args.year.length === 1 ? `open ./output/${args.year[0]}` : 'open ./output',
    chalk.dim('to view the files')
  );
  if (failedExports.length) {
    logError(`${failedExports.length} failed export${failedExports.length === 1 ? '' : 's'}:`);
    logDetail(failedExports.join('\n  '));
  }
})();