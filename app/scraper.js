const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const fs = require('fs')
const cheerio = require('cheerio')

puppeteer.use(StealthPlugin())

const endpoint = 'https://dice.fm/venue/tubbys-kingston-8qa5'

let gigzArr = []

const retry = async (fn, retries, delay) => {
  try {
    return await fn()
  } catch (error) {
    if (retries > 1) {
      await new Promise(resolve => setTimeout(resolve, delay))
      return retry(fn, retries - 1, delay)
    } else {
      throw error
    }
  }
}

const processExcerpt = (excerpt, link) => {
  let formattedExcerpt = ''

  if (excerpt) {
    formattedExcerpt += `<p>${excerpt}</p><br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`
  }

  if (link && !excerpt) {
    formattedExcerpt += `<br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`
  } else if (!link && !excerpt) {
    formattedExcerpt = ''
  }

  return formattedExcerpt
}

const formatDateStringForMongoDB = dateString => {
  const currentYear = new Date().getFullYear()
  const date = new Date(`${dateString} ${currentYear}`)

  let isoString = date.toISOString()
  let datePart = isoString.split('T')[0]
  let timePart = '00:00:00.000'
  let timezoneOffset = '+00:00'

  return `${datePart}T${timePart}${timezoneOffset}`
}

;(async () => {
  const browser = await puppeteer.launch({ headless: false })
  const page = await browser.newPage()

  try {
    await page.goto(endpoint, { waitUntil: 'domcontentloaded' })

    await page.waitForSelector('a.EventParts__EventLink-sc-db999af1-8.dLNxmE')

    const eventLinks = await dynamicScrollAndCollectLinks(
      page,
      'a.EventParts__EventLink-sc-db999af1-8.dLNxmE'
    )
    console.log(`Collected ${eventLinks.length} event links with images`)

    for (const { link } of eventLinks) {
      const gigDetails = await scrapeEventDetails(page, link)
      if (gigDetails) gigzArr.push(gigDetails)
    }

    console.log(`Scraped ${gigzArr.length} event details`)
  } catch (error) {
    console.error('Error during the main process: ', error)
  } finally {
    await browser.close()

    if (gigzArr.length) {
      fs.writeFileSync('events.json', JSON.stringify(gigzArr, null, 2), 'utf-8')
      console.log('Data saved to events.json')
    } else {
      console.log('No data to save.')
    }
  }
})()

const dynamicScrollAndCollectLinks = async (page, selector) => {
  let links = new Set()
  try {
    let previousSize = 0
    let newSize = 0
    do {
      previousSize = links.size
      const newLinks = await page.$$eval(selector, elements =>
        elements.map(el => {
          return {
            link: el.href
          }
        })
      )
      newLinks.forEach(item => links.add(JSON.stringify(item)))
      newSize = links.size
      if (newSize > previousSize) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    } while (newSize > previousSize)
  } catch (error) {
    console.error('Error during dynamic scroll and link collection: ', error)
  }
  return Array.from(links).map(item => JSON.parse(item))
}

const scrapeEventDetails = async (page, link) => {
  try {
    await retry(
      async () => {
        return await page.goto(link, { waitUntil: 'domcontentloaded' })
      },
      3,
      1000
    )

    let title,
      date,
      genre,
      time,
      location,
      price,
      image,
      excerpt,
      isFeatured,
      buyNowLink

    try {
      title = await page.$eval(
        'h1.EventDetailsTitle__Title-sc-8ebcf47a-0.iLdkPz',
        el => el.textContent.trim()
      )
    } catch (err) {
      console.error(`Error finding title: `, err)
      title = null
    }

    try {
      const dateTimeText = await page.$eval(
        'div.EventDetailsTitle__Date-sc-8ebcf47a-2.hwEQMH',
        el => el.textContent.trim()
      )
      const parts = dateTimeText.split(',')
      date = `${parts[0].trim()}, ${parts[1].trim()}`
      time = parts[2].trim()
    } catch (err) {
      console.error(`Error finding date and time: `, err)
      date = null
      time = null
    }

    try {
      location = await page.$eval(
        'div.EventDetailsTitle__Venues-sc-8ebcf47a-1 span',
        el => el.textContent.trim()
      )
    } catch (err) {
      console.error(`Error finding location with first selector: `, err)
      try {
        location = await page.$eval(
          'div[class="EventDetailsTitle__Venues-sc-8ebcf47a-1 cqBRcR"] a',
          el => el.textContent.trim()
        )
      } catch (err) {
        console.error(`Error finding location with second selector: `, err)
        location = null
      }
    }

    try {
      price = await page.$eval(
        'div.EventDetailsCallToAction__PriceRow-sc-3e9a4f58-1 span',
        el => el.textContent.trim()
      )
    } catch (err) {
      console.error(`Error finding price: `, err)
      price = null
    }

    try {
      image = await page.$eval(
        'img.EventDetailsImage__Image-sc-869461fe-1',
        el => el.src
      )
    } catch (err) {
      console.error(`Error finding image: `, err)
      image = null
    }

    try {
      excerpt = await page.$eval(
        'div.EventDetailsAbout__Text-sc-6411bf4-1',
        el => el.textContent.trim()
      )
    } catch (err) {
      console.error(`Error finding excerpt: `, err)
      excerpt = null
    }

    isFeatured = false

    const genreKeywords = {
      'black metal': ['black metal'],
      metal: ['metal'],
      'nu metal': ['nu metal'],
      punk: ['punk'],
      'post punk': ['post punk', 'post - punk', 'post-punk'],
      'stoner rock': ['stoner rock'],
      'post rock': ['post rock', 'post - rock', 'post-rock'],
      rock: ['rock'],
      edm: ['edm'],
      synth: ['synth'],
      industrial: ['industrial'],
      pop: ['pop'],
      'hip-hop': ['hip-hop', 'hip hop'],
      oi: ['oi'],
      emo: ['emo'],
      other: ['other']
    }

    const findGenre = text => {
      text = text.toLowerCase()
      for (const [genre, keywords] of Object.entries(genreKeywords)) {
        if (keywords.some(keyword => text.includes(keyword))) {
          return genre
        }
      }
      return '¯\\_(ツ)_/¯'
    }

    genre = findGenre(excerpt || '')

    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button span')).map(button =>
        button.textContent.trim()
      )
    )

    buyNowLink = link

    date = formatDateStringForMongoDB(date)
    excerpt = processExcerpt(excerpt, buyNowLink)

    return {
      title,
      date,
      genre,
      time,
      location,
      price,
      image,
      excerpt,
      isFeatured
    }
  } catch (error) {
    console.error(`Error scraping details from ${link}: `, error)
    return null
  }
}
